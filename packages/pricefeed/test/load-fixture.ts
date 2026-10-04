import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters,
  parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, reviewed, body, metadata, event } from './publication-fixture.js';
import { Journal } from '../src/journal.js';
import { PacketStore, packetNamespace, type PacketDomain } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalPipeline } from '../src/pipeline.js';
import { Worker, type Provider } from '../src/worker.js';
import { RequestLimiter } from '../src/polymarket.js';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy } from '../src/local-relay.js';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { rulesHash } from '../src/rules.js';
import { INGRESS_ABI, type Observation } from '../src/wire.js';
import { ACCEPTED_ABI, type DeliveryReceipt } from '../src/receipts.js';

export const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
export async function until(check:()=>boolean):Promise<void>{
  const end=performance.now()+1500;while(!check()){if(performance.now()>end)throw new Error('FIXTURE_WAIT_TIMEOUT');await pause(1);}
}
const word=(n:number)=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);

/** Real development classes, scripted source/RPC. No network client is constructed. */
export function loadFixture(count:number,options:{sourceDelayMs?:number;rpcDelayMs?:number;maxPending?:number}={}) {
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-load-')),begun=performance.now();let offset=0n;
  const now=()=>1000100n+BigInt(Math.floor(performance.now()-begun))+offset;
  const journal=new Journal(join(dir,'source.sqlite')),packets=new PacketStore(join(dir,'packets.sqlite'));
  const limiter=new RequestLimiter(1,options.maxPending??500);
  const stats={sourceCalls:0,sourceActive:0,maxSourceActive:0,rpcCalls:0,rpcActive:0,maxRpcActive:0,
    perWorkerPolls:Array<number>(count).fill(0),maxBookActive:Array<number>(count).fill(0),
    sourceAgeAtBroadcastMs:[] as string[],headroomAtBroadcastMs:[] as string[],elapsedSinceSigningAtSimulationMs:[] as string[]};
  const signedAt=new Map<string,bigint>();
  const bookActive=Array<number>(count).fill(0);
  let sourceHook:((index:number,phase:string)=>Promise<void>)=async()=>{};
  let rpcHook:((phase:string,data:Hex|null)=>Promise<void>)=async()=>{};
  const rpc=async<T>(phase:string,fn:()=>T|Promise<T>,data:Hex|null=null):Promise<T>=>{
    stats.rpcCalls++;stats.rpcActive++;stats.maxRpcActive=Math.max(stats.maxRpcActive,stats.rpcActive);
    try{await rpcHook(phase,data);if(options.rpcDelayMs)await pause(options.rpcDelayMs);return await fn();}
    finally{stats.rpcActive--;}
  };
  const entries=Array.from({length:count},(_,index)=>{
    const mapping={...config.mapping,eventId:String(50000+index),externalMarketId:String(60000+index),
      conditionId:word(70000+index),outcomeTokenId:String(80000+index)};
    const m={...metadata,id:mapping.externalMarketId,conditionId:mapping.conditionId,
      clobTokenIds:[mapping.outcomeTokenId,'999999'],question:`Load fixture ${index}`};
    const e={...event,id:mapping.eventId,markets:[{id:mapping.externalMarketId}]};
    const cfg={...config,key:`load-${index}`,category:(['crypto','sports','politics'] as const)[index%3]!,mapping,
      poll:{...config.poll,intervalMs:10,timeoutMs:1,maxRetries:0,retryDelayMs:0},
      destination:{...config.destination!,marketId:word(90000+index),sourceId:word(100000+index)}};
    const external='0x'+createHash('sha256').update(`${verifyEventMembership(cfg,e).rulesDigest}:${metadataIdentity(cfg,m).rulesDigest}`).digest('hex');
    const rules={...reviewed,...mapping,marketId:cfg.destination.marketId,sourceId:cfg.destination.sourceId,externalRulesDigest:external};
    cfg.destination.sourceRulesHash=rulesHash(rules);
    const domain:PacketDomain={chainId:31337n,engine:cfg.destination.engineAddress,marketId:rules.marketId,
      sourceId:rules.sourceId,rulesHash:rulesHash(rules),signer:cfg.destination.signerAddress};
    const capture=async(phase:string,data:()=>Record<string,unknown>)=>{
      await limiter.acquire();stats.sourceCalls++;stats.sourceActive++;stats.maxSourceActive=Math.max(stats.maxSourceActive,stats.sourceActive);
      if(phase==='book'){bookActive[index]!++;stats.maxBookActive[index]=Math.max(stats.maxBookActive[index]!,bookActive[index]!);stats.perWorkerPolls[index]!++;}
      try{
        const started=now();await sourceHook(index,phase);if(options.sourceDelayMs)await pause(options.sourceDelayMs);
        const value=data();return {url:'https://fixture.invalid',data:value,body:JSON.stringify(value),headers:{},attempts:1,
          receivedAtMs:now(),latencyMs:now()-started};
      }finally{stats.sourceActive--;if(phase==='book')bookActive[index]!--;}
    };
    const provider:Provider={event:async()=>capture('event',()=>e),metadata:async()=>capture('metadata',()=>m),
      book:async()=>capture('book',()=>({...JSON.parse(body),market:mapping.conditionId,asset_id:mapping.outcomeTokenId,timestamp:(now()-100n).toString()}))};
    const worker=new Worker(cfg,provider,journal,`collector-${index}`,now);
    const signer=new LocalTestSigner(join(dir,'signer.sqlite'),domain,packets,now);
    const signDigest=signer.signDigest.bind(signer);
    signer.signDigest=async request=>{const signature=await signDigest(request);signedAt.set(request.identity,now());return signature;};
    return {worker,signer,rules,domain};
  });
  const bySource=new Map(entries.map(e=>[e.domain.sourceId,e]));
  let nextNonce=0n;
  const receipts=new Map<Hex,DeliveryReceipt>(),blocks=new Map<bigint,{number:bigint;hash:Hex;timestamp:bigint}>();
  const chains=new Map<string,{lastSequence:bigint;lastObservedAt:bigint}>(),sent:Hex[]=[];
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:sender.address,
    pendingNonce:async()=>rpc('pendingNonce',()=>nextNonce),
    identity:async d=>rpc('identity',()=>{
      const entry=bySource.get(d.sourceId)!,cfg=entry.worker.config;
      return {chainId:31337n,engineCodeHash:cfg.destination!.engineCodeHash,abiHash:cfg.destination!.abiHash,
        signer:d.signer,rulesHash:d.rulesHash,...(chains.get(d.sourceId)??{lastSequence:0n,lastObservedAt:0n}),
        listing:{...cfg.destination,indexSourceId:d.sourceId,indexSigner:d.signer,indexRulesHash:d.rulesHash,
          depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad}};
    }),
    simulate:async(_to,data)=>{
      const obs=decodeFunctionData({abi:INGRESS_ABI,data}).args[0] as unknown as Observation,d=bySource.get(obs.sourceId)!.domain;
      const at=signedAt.get(packetNamespace(d)+':'+obs.sequence);
      if(at!==undefined)stats.elapsedSinceSigningAtSimulationMs.push((now()-at).toString());
      return rpc('simulate',()=>{},data);
    },
    prepare:async req=>rpc('prepare',()=>sender.signTransaction({type:'eip1559',chainId:31337,to:req.to as Hex,data:req.data,
      nonce:Number(req.nonce),gas:req.gas,maxFeePerGas:req.maxFeePerGas,maxPriorityFeePerGas:req.maxPriorityFeePerGas,value:0n}),req.data),
    broadcast:async raw=>rpc('broadcast',()=>{
      const tx=parseTransaction(raw),o=decodeFunctionData({abi:INGRESS_ABI,data:tx.data!}).args[0] as unknown as Observation;
      if(BigInt(tx.nonce!)!==nextNonce)throw new Error('FIXTURE_NONCE_ORDER');nextNonce++;
      const entry=bySource.get(o.sourceId)!,packet=packets.get(entry.domain,o.sequence)!,hash=keccak256(raw);
      const number=nextNonce,blockHash=word(Number(number)) as Hex,timestamp=now()/1000n;
      stats.sourceAgeAtBroadcastMs.push((now()-packet.packet.sourceMs).toString());
      stats.headroomAtBroadcastMs.push(((o.observedAt+30n)*1000n-now()).toString());
      chains.set(o.sourceId,{lastSequence:o.sequence,lastObservedAt:o.observedAt});sent.push(raw);
      blocks.set(number,{number,hash:blockHash,timestamp});
      receipts.set(hash,{status:'success',transactionHash:hash,blockNumber:number,blockHash,logs:[{
        address:entry.domain.engine,transactionHash:hash,blockNumber:number,blockHash,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,timestamp,o.priceWad,true,packet.digest])}]});return hash;
    }),
    receipt:async hash=>rpc('receipt',()=>receipts.get(hash)??null),
    block:async number=>rpc('block',()=>blocks.get(number)??null),head:async()=>rpc('head',()=>nextNonce),
  };
  const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
    headroomMs:1000n,confirmations:1n,timeoutMs:2000,maxAttempts:3,leaseMs:60000n};
  const relay=new LocalRelay(join(dir,'relay.sqlite'),packets,transport,policy,now);
  const pipeline=new LocalPipeline(entries,packets,relay,transport,policy,now);
  return {dir,entries,workers:entries.map(e=>e.worker),journal,packets,relay,pipeline,transport,policy,stats,sent,now,
    advance:(ms:bigint)=>{offset+=ms;},onSource:(hook:typeof sourceHook)=>{sourceHook=hook;},onRpc:(hook:typeof rpcHook)=>{rpcHook=hook;},
    report:()=>({workers:count,elapsedMs:Math.round((performance.now()-begun)*1000)/1000,...stats,
      categories:entries.map(e=>e.worker.config.category),accepted:sent.length,externalTransactions:0,
      source:'scripted fixtures',chain:'scripted RPC/receipts',clock:'monotonic elapsed ms plus explicitly injected offset',
      sourceEvidenceValid:journal.verify(),packetEvidenceValid:packets.verify()}),
    close:()=>{pipeline.close();relay.close();entries.forEach(e=>e.signer.close());packets.close();journal.close();rmSync(dir,{recursive:true,force:true});},
  };
}
