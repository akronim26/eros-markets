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
import { config, reviewed, invalidConfig, invalidReviewed, body, metadata, event, candidate, h } from './publication-fixture.js';
import { prepareObservation } from '../src/publication.js';
import { rulesHash } from '../src/rules.js';
import { INGRESS_ABI, type Observation } from '../src/wire.js';
import { localRpcTransport } from '../src/local-rpc.js';

const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
  headroomMs:1000n,confirmations:1n,timeoutMs:100,maxAttempts:3,leaseMs:1000n};
async function setup(invalidPolicy=false){
  const cfg=invalidPolicy?invalidConfig:config,rules=invalidPolicy?invalidReviewed:reviewed;
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-pipeline-'));let now=1000100n,chainSeq=0n,chainTime=0n,failSend=false;
  const packets=new PacketStore(join(dir,'packets.sqlite')),journal=new Journal(join(dir,'source.sqlite'));
  const domain={...candidate(1n).domain,rulesHash:cfg.destination!.sourceRulesHash};
  const signer=new LocalTestSigner(join(dir,'signer.sqlite'),domain,packets,()=>now);
  const sent:Hex[]=[],receipts=new Map<Hex,DeliveryReceipt>();let blockTime=1001n;
  const provider:Provider={event:async()=>capture(event),metadata:async()=>capture(metadata),book:async()=>capture(JSON.parse(body))};
  function capture(data:Record<string,unknown>){return {url:'https://fixture.invalid',receivedAtMs:now-50n,
    latencyMs:1n,body:JSON.stringify(data),headers:{},data,attempts:1};}
  const worker=new Worker(cfg,provider,journal,'collector',()=>now);
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:sender.address,pendingNonce:async()=>BigInt(receipts.size),
    identity:async()=>({chainId:31337n,engineCodeHash:cfg.destination!.engineCodeHash,abiHash:cfg.destination!.abiHash,
      signer:domain.signer,rulesHash:domain.rulesHash,lastSequence:chainSeq,lastObservedAt:chainTime,
      listing:{...cfg.destination,indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
        depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad}}),
    simulate:async()=>{},prepare:async(req)=>sender.signTransaction({type:'eip1559',chainId:31337,
      to:req.to as Hex,data:req.data,nonce:Number(req.nonce),gas:req.gas,maxFeePerGas:req.maxFeePerGas,maxPriorityFeePerGas:req.maxPriorityFeePerGas,value:0n}),
    broadcast:async(raw)=>{sent.push(raw);if(failSend)throw new Error('UNKNOWN_SEND');
      const obs=decodeFunctionData({abi:INGRESS_ABI,data:parseTransaction(raw).data!}).args[0] as unknown as Observation;
      const seq=obs.sequence,packet=packets.get(domain,seq)!;
      const o=packet.packet.observation,tx=keccak256(raw);chainSeq=seq;chainTime=o.observedAt;blockTime=(now+999n)/1000n;
      receipts.set(tx,{status:'success',transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logs:[{
        address:domain.engine,transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,blockTime,o.priceWad,o.impactBidWad>0n,packet.digest])}]});return tx;},
    receipt:async(hash)=>receipts.get(hash)??null,block:async(n)=>({number:n,hash:h('aa') as Hex,timestamp:blockTime}),head:async()=>10n};
  const relay=new LocalRelay(join(dir,'relay.sqlite'),packets,transport,policy,()=>now);
  const pipeline=new LocalPipeline([{worker,rules,signer}],packets,relay,transport,policy,()=>now);
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
    // A quarantined source must not stop independent markets or release its old packet.
    const quarantined=await s.worker.poll();quarantined.inspection={...quarantined.inspection,status:'QUARANTINED',reason:'SOURCE_RULES_CHANGED'};
    assert.equal((await joined.process(quarantined)).state,'QUARANTINED');
    const healthy=await joined.process(await second.poll());assert.equal(healthy.state,'FINALIZED');assert.equal(healthy.sequence,2n);
    assert.equal((await joined.process(await s.worker.poll())).state,'QUARANTINED');
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
    const sends=q.sent.length;assert.equal((await q.pipeline.process(result)).state,'QUARANTINED');assert.equal(q.sent.length,sends);
  }finally{q.close();}
});
test('concrete RPC adapter rejects external destinations and missing listing ABI before any request',()=>{
  assert.throws(()=>localRpcTransport('https://mainnet.example',[]),/LOCAL_RPC_ONLY/);
  assert.throws(()=>localRpcTransport('http://127.0.0.1:8545',[]),/LISTING_ABI/);
});

test('new invalid source evidence does not rebroadcast an older valid packet, but its receipt is reconciled',async()=>{
  const s=await setup();try{
    await s.pipeline.start();s.setFail(true);
    await s.pipeline.process(await s.worker.poll());
    const frozen=s.packets.get(s.domain,1n)!,raw=s.sent[0];
    s.provider.book=async()=>{
      const data={...JSON.parse(body),asks:[{price:'0.90',size:'6'}]};
      return {url:'fixture://wide',receivedAtMs:1000050n,latencyMs:1n,body:JSON.stringify(data),headers:{},data,attempts:1};
    };
    const invalid=await s.worker.poll();assert.equal(invalid.inspection.status,'INVALID_DEPTH');
    const sends=s.sent.length,result=await s.pipeline.process(invalid);
    assert.equal(result.state,'SOURCE_UNAVAILABLE');assert.match(result.reason!,/INVALID_DEPTH/);
    assert.equal(s.sent.length,sends);assert.deepEqual(s.packets.get(s.domain,1n),frozen);
    assert.equal(s.packets.list(s.domain).length,1);
    // A receipt may arrive while source data is invalid. Reconciliation is read-only.
    s.setFail(false);await s.transport.broadcast(raw!);const afterExternalSend=s.sent.length;
    const accepted=await s.pipeline.process(await s.worker.poll());
    assert.equal(accepted.state,'FINALIZED');assert.equal(accepted.sequence,1n);
    assert.equal(s.sent.length,afterExternalSend);assert.equal(s.packets.list(s.domain).length,1);
  }finally{s.close();}
});

test('restart expires an unsent allocation and burns its sequence before publishing new evidence',async()=>{
  const s=await setup();try{
    const fence=s.packets.acquire(s.domain,'crashed',1000100n,1000n);
    s.packets.reconcile(s.domain,'crashed',fence,1000100n,{lastSequence:0n,lastObservedAt:0n});
    s.packets.allocate(s.domain,'crashed',fence,1000100n,seq=>candidate(seq));
    s.packets.release(s.domain,'crashed',fence);s.setNow(1030001n);
    await s.pipeline.start();
    const expired=await s.pipeline.process(await s.worker.poll());assert.equal(expired.state,'EXPIRED');
    assert.equal(expired.sequence,1n);assert.equal(s.sent.length,0);assert.equal(s.signer.reservations().length,0);
    assert.equal(s.packets.get(s.domain,1n)!.packet.observation.publishedAt,1000n);
    const data={...JSON.parse(body),timestamp:'1030000'};
    s.provider.book=async()=>({url:'fixture://fresh',receivedAtMs:1030001n,latencyMs:1n,body:JSON.stringify(data),headers:{},data,attempts:1});
    const next=await s.pipeline.process(await s.worker.poll());
    assert.equal(next.state,'FINALIZED');assert.equal(next.sequence,2n);
    assert.equal(parseTransaction(s.sent[0]!).nonce,0);assert.equal(s.packets.get(s.domain,1n)!.state,'EXPIRED');
  }finally{s.close();}
});

function wideProvider(s:Awaited<ReturnType<typeof setup>>):void {
  const data={...JSON.parse(body),asks:[{price:'0.90',size:'6'}]};
  s.provider.book=async()=>({url:'fixture://wide',receivedAtMs:1000050n,latencyMs:1n,
    body:JSON.stringify(data),headers:{},data,attempts:1});
}
test('opted-in joined pipeline delivers invalid checkpoints and archives original calculated impacts',async()=>{
  const s=await setup(true);try{
    await s.pipeline.start();assert.equal((await s.pipeline.process(await s.worker.poll())).depthValid,true);
    wideProvider(s);const output=await s.pipeline.process(await s.worker.poll());
    assert.equal(output.state,'FINALIZED');assert.equal(output.depthValid,false);assert.equal(output.sequence,2n);
    const o=s.packets.get(s.domain,2n)!.packet.observation;
    assert.deepEqual([o.priceWad,o.impactBidWad,o.impactAskWad,o.bidDepthLots,o.askDepthLots],[0n,0n,0n,6000n,6000n]);
    const inspection=s.journal.latest(s.worker.namespace)!.payload.inspection as Record<string,unknown>;
    const summary=inspection.summary as Record<string,unknown>;
    assert.equal(inspection.reason,'EXCESSIVE_SPREAD');assert.equal(summary.impactAskWad,'900000000000000000');
    assert.equal(s.journal.verify(),true);assert.equal(s.packets.verify(),true);
  }finally{s.close();}
});
test('fresh invalid checkpoint supersedes an unsent valid allocation without reusing its sequence',async()=>{
  const s=await setup(true);try{
    const fence=s.packets.acquire(s.domain,'crashed',1000100n,1000n);
    s.packets.reconcile(s.domain,'crashed',fence,1000100n,{lastSequence:0n,lastObservedAt:0n});
    s.packets.allocate(s.domain,'crashed',fence,1000100n,seq=>prepareObservation(invalidConfig,invalidReviewed,
      {bookBody:body,metadata,event,bookReceivedAtMs:1000050n,metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},seq,1000100n,1000n));
    s.packets.release(s.domain,'crashed',fence);wideProvider(s);await s.pipeline.start();
    const output=await s.pipeline.process(await s.worker.poll());
    assert.equal(output.sequence,2n);assert.equal(output.depthValid,false);assert.equal(s.sent.length,1);
    assert.equal(parseTransaction(s.sent[0]!).nonce,0);
    assert.equal(s.packets.get(s.domain,1n)!.state,'EXPIRED');
    assert.equal(s.packets.get(s.domain,1n)!.reason,'SUPERSEDED_BY_FRESH_INVALID_DEPTH');
    assert.equal(s.packets.get(s.domain,1n)!.packet.observation.priceWad,600000000000000000n);
  }finally{s.close();}
});
test('invalid transition cannot skip an unknown valid transaction or mutate its frozen packet',async()=>{
  const s=await setup(true);try{
    await s.pipeline.start();s.setFail(true);await s.pipeline.process(await s.worker.poll());
    const frozen=s.packets.get(s.domain,1n),sends=s.sent.length;wideProvider(s);
    const blocked=await s.pipeline.process(await s.worker.poll());
    assert.equal(blocked.state,'SOURCE_UNAVAILABLE');assert.equal(blocked.reason,'INVALID_TRANSITION_BLOCKED_BY_PENDING_DELIVERY');
    assert.equal(s.sent.length,sends);assert.equal(s.packets.list(s.domain).length,1);
    assert.deepEqual(s.packets.get(s.domain,1n),frozen);
    s.setFail(false);await s.transport.broadcast(s.sent[0]!);
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'FINALIZED');
    const invalid=await s.pipeline.process(await s.worker.poll());
    assert.equal(invalid.sequence,2n);assert.equal(invalid.depthValid,false);
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),[0,0,1]);
  }finally{s.close();}
});

test('source outage suppresses rebroadcast while retaining immutable unresolved delivery',async()=>{
  const s=await setup();try{
    await s.pipeline.start();s.setFail(true);await s.pipeline.process(await s.worker.poll());
    const raw=s.sent[0],frozen=s.packets.get(s.domain,1n),sends=s.sent.length;
    s.provider.book=async()=>{throw new Error('SOURCE_TIMEOUT');};
    const gap=await s.pipeline.process(await s.worker.poll());assert.equal(gap.state,'SOURCE_UNAVAILABLE');
    assert.equal(gap.reason,'SOURCE_TIMEOUT');assert.equal(s.sent.length,sends);
    assert.deepEqual(s.packets.get(s.domain,1n),frozen);
    s.setFail(false);await s.transport.broadcast(raw!);
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'FINALIZED');
    assert.equal(s.packets.list(s.domain).length,1);
  }finally{s.close();}
});
