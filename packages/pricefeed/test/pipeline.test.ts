import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalPipeline } from '../src/pipeline.js';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy } from '../src/local-relay.js';
import { PacketStore } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { ACCEPTED_ABI, type DeliveryReceipt } from '../src/receipts.js';
import { Journal } from '../src/journal.js';
import { Worker, type Provider } from '../src/worker.js';
import { config, reviewed, body, metadata, event, candidate, h } from './publication-fixture.js';
import { rulesHash } from '../src/rules.js';
import { INGRESS_ABI, type Observation } from '../src/wire.js';
import { localRpcTransport } from '../src/local-rpc.js';

const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
  headroomMs:1000n,confirmations:1n,timeoutMs:100,maxAttempts:3,leaseMs:1000n};
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-pipeline-'));let now=1000100n,chainSeq=0n,chainTime=0n,failSend=false;
  const packets=new PacketStore(join(dir,'packets.sqlite')),journal=new Journal(join(dir,'source.sqlite'));
  const domain=candidate(1n).domain;
  const signer=new LocalTestSigner(join(dir,'signer.sqlite'),domain,packets,()=>now);
  const sent:Hex[]=[],receipts=new Map<Hex,DeliveryReceipt>();
  const provider:Provider={event:async()=>capture(event),metadata:async()=>capture(metadata),book:async()=>capture(JSON.parse(body))};
  function capture(data:Record<string,unknown>){return {url:'https://fixture.invalid',receivedAtMs:1000050n,
    latencyMs:1n,body:JSON.stringify(data),headers:{},data,attempts:1};}
  const worker=new Worker(config,provider,journal,'collector',()=>now);
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:sender.address,pendingNonce:async()=>BigInt(receipts.size),
    identity:async()=>({chainId:31337n,engineCodeHash:config.destination!.engineCodeHash,abiHash:config.destination!.abiHash,
      signer:domain.signer,rulesHash:domain.rulesHash,lastSequence:chainSeq,lastObservedAt:chainTime,
      listing:{...config.destination,indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
        depthNLots:config.pricing.depthNLots,maxSpreadWad:config.pricing.maxSpreadWad}}),
    simulate:async()=>{},prepare:async(req)=>sender.signTransaction({type:'eip1559',chainId:31337,
      to:req.to as Hex,data:req.data,nonce:Number(req.nonce),gas:req.gas,maxFeePerGas:req.maxFeePerGas,maxPriorityFeePerGas:req.maxPriorityFeePerGas,value:0n}),
    broadcast:async(raw)=>{sent.push(raw);if(failSend)throw new Error('UNKNOWN_SEND');
      const seq=BigInt(sent.filter((v,i,a)=>a.indexOf(v)===i).length),packet=packets.get(domain,seq)!;
      const o=packet.packet.observation,tx=keccak256(raw);chainSeq=seq;chainTime=o.observedAt;
      receipts.set(tx,{status:'success',transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logs:[{
        address:domain.engine,transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,1001n,o.priceWad,true,packet.digest])}]});return tx;},
    receipt:async(hash)=>receipts.get(hash)??null,block:async(n)=>({number:n,hash:h('aa') as Hex,timestamp:1001n}),head:async()=>10n};
  const relay=new LocalRelay(join(dir,'relay.sqlite'),packets,transport,policy,()=>now);
  const pipeline=new LocalPipeline([{worker,rules:reviewed,signer}],packets,relay,transport,policy,()=>now);
  return {dir,domain,packets,journal,signer,relay,pipeline,worker,provider,transport,sent,
    setNow:(n:bigint)=>{now=n;},setFail:(v:boolean)=>{failSend=v;},setChain:(s:bigint)=>{chainSeq=s;chainTime=s===0n?0n:1000n;},
    close:()=>{pipeline.close();relay.close();signer.close();packets.close();journal.close();rmSync(dir,{recursive:true,force:true});}};
}
test('joined pipeline archives, builds, signs, sends and validates acceptance; degraded input creates no packet',async()=>{
  const s=await setup();try{
    await s.pipeline.start();const result=await s.pipeline.process(await s.worker.poll());
    assert.equal(result.state,'FINALIZED');assert.equal(result.sequence,1n);assert.equal(s.sent.length,1);
    assert.equal(s.packets.get(s.domain,1n)!.packet.observation.priceWad,600000000000000000n);
    assert.equal(s.journal.verify(),true);assert.equal(s.signer.reservations().length,1);
    s.provider.book=async()=>{throw new Error('SOURCE_TIMEOUT');};
    const degraded=await s.pipeline.process(await s.worker.poll());assert.equal(degraded.state,'SOURCE_UNAVAILABLE');
    assert.equal(s.packets.list(s.domain).length,1);assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('unknown delivery blocks newer allocation and restart retries the identical packet/transaction',async()=>{
  const s=await setup();let replacement:LocalPipeline|undefined;
  try{
    await s.pipeline.start();s.setFail(true);
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'UNKNOWN');
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'UNKNOWN');
    assert.equal(s.packets.list(s.domain).length,1);
    const raw=s.sent[0];s.pipeline.close();s.setFail(false);
    replacement=new LocalPipeline([{worker:s.worker,rules:reviewed,signer:s.signer}],s.packets,s.relay,s.transport,policy,()=>1000100n);
    await replacement.start();const recovered=await replacement.process(await s.worker.poll());
    assert.equal(recovered.state,'FINALIZED');assert.equal(recovered.sequence,1n);
    assert.ok(s.sent.every(value=>value===raw));assert.equal(s.signer.reservations().length,1);
  }finally{replacement?.close();s.close();}
});
test('overlapping callbacks are rejected and successive observations consume distinct shared nonces',async()=>{
  const s=await setup();try{
    await s.pipeline.start();const snapshot=await s.worker.poll();
    const first=s.pipeline.process(snapshot);await assert.rejects(s.pipeline.process(snapshot),/WORKER_BUSY/);await first;
    // Independent subsequent observations consume distinct transaction nonces.
    await s.pipeline.process(await s.worker.poll());
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),[0,1]);
  }finally{s.close();}
});
test('startup rejects unknown higher onchain state and active leases renew without sequence reuse',async()=>{
  const s=await setup();try{
    s.setChain(50n);await assert.rejects(s.pipeline.start(),/UNKNOWN_CHAIN_SEQUENCE/);
    s.setChain(0n);await s.pipeline.start();s.setNow(1000800n);s.pipeline.renew();s.setNow(1001200n);
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'FINALIZED');
  }finally{s.close();}
});
test('two market workers sign independent sequences while one relay serializes their concurrent nonces',async()=>{
  const s=await setup();let joined:LocalPipeline|undefined,secondSigner:LocalTestSigner|undefined;
  try{
    s.pipeline.close();
    const rules={...reviewed,marketId:h('09'),sourceId:h('0a')};
    const cfg={...config,key:'second',destination:{...config.destination!,engineAddress:'0x3333333333333333333333333333333333333333',
      marketId:rules.marketId,sourceId:rules.sourceId,sourceRulesHash:rulesHash(rules)}};
    const secondDomain={...s.domain,engine:cfg.destination.engineAddress,marketId:rules.marketId,sourceId:rules.sourceId,rulesHash:rulesHash(rules)};
    secondSigner=new LocalTestSigner(join(s.dir,'signer.sqlite'),secondDomain,s.packets,()=>1000100n);
    const second=new Worker(cfg,s.provider,s.journal,'second-collector',()=>1000100n);
    const receipts=new Map<Hex,DeliveryReceipt>(),sequences=new Map<string,bigint>();
    s.transport.identity=async domain=>{
      const c=domain.engine===secondDomain.engine?cfg:config;
      return {chainId:31337n,engineCodeHash:c.destination!.engineCodeHash,abiHash:c.destination!.abiHash,signer:domain.signer,
        rulesHash:domain.rulesHash,lastSequence:sequences.get(domain.engine)??0n,lastObservedAt:sequences.has(domain.engine)?1000n:0n,
        listing:{...c.destination,indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
          depthNLots:c.pricing.depthNLots,maxSpreadWad:c.pricing.maxSpreadWad}};};
    s.transport.broadcast=async raw=>{
      s.sent.push(raw);const tx=parseTransaction(raw),d=tx.to===secondDomain.engine?secondDomain:s.domain;
      const obs=decodeFunctionData({abi:INGRESS_ABI,data:tx.data!}).args[0] as unknown as Observation,p=s.packets.get(d,obs.sequence)!,hash=keccak256(raw);
      sequences.set(d.engine,obs.sequence);
      receipts.set(hash,{status:'success',transactionHash:hash,blockNumber:10n,blockHash:h('aa') as Hex,logs:[{
        address:d.engine,transactionHash:hash,blockNumber:10n,blockHash:h('aa') as Hex,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:obs.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [obs.sequence,obs.observedAt,obs.publishedAt,1001n,obs.priceWad,true,p.digest])}]});return hash;};
    s.transport.receipt=async hash=>receipts.get(hash)??null;
    joined=new LocalPipeline([{worker:s.worker,rules:reviewed,signer:s.signer},{worker:second,rules,signer:secondSigner}],
      s.packets,s.relay,s.transport,policy,()=>1000100n);
    await joined.start();const results=await Promise.all([s.worker.poll(),second.poll()]);
    const outputs=await Promise.all(results.map(result=>joined!.process(result)));
    assert.deepEqual(outputs.map(r=>[r.state,r.sequence]),[['FINALIZED',1n],['FINALIZED',1n]]);
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),[0,1]);
    assert.equal(s.signer.reservations().length,1);assert.equal(secondSigner.reservations().length,1);
  }finally{joined?.close();secondSigner?.close();s.close();}
});
test('continuous joined service shuts down cleanly and source quarantine cannot resume an unknown send',async()=>{
  const s=await setup();try{
    const stop=new AbortController(),outputs:string[]=[];
    await s.pipeline.run(stop.signal,result=>{outputs.push(result.state);stop.abort();});
    assert.deepEqual(outputs,['FINALIZED']);await assert.rejects(s.pipeline.process(await s.worker.poll()),/START_REQUIRED/);
    assert.equal(s.packets.verify(),true);
  }finally{s.close();}
  const q=await setup();try{
    await q.pipeline.start();q.setFail(true);await q.pipeline.process(await q.worker.poll());
    const result=await q.worker.poll();result.inspection={...result.inspection,status:'QUARANTINED',reason:'SOURCE_RULES_CHANGED'};
    const sends=q.sent.length;await assert.rejects(q.pipeline.process(result),/SOURCE_QUARANTINED/);assert.equal(q.sent.length,sends);
  }finally{q.close();}
});
test('concrete RPC adapter rejects external destinations and missing listing ABI before any request',()=>{
  assert.throws(()=>localRpcTransport('https://mainnet.example',[]),/LOCAL_RPC_ONLY/);
  assert.throws(()=>localRpcTransport('http://127.0.0.1:8545',[]),/LISTING_ABI/);
});
