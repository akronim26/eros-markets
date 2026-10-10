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
import { LocalLifecycle } from '../src/lifecycle.js';
import { SourceSnapshotBuffer } from '../src/source-buffer.js';
import { parseConfig } from '../src/config.js';

const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
  headroomMs:1000n,confirmations:1n,timeoutMs:100,maxAttempts:3,leaseMs:1000n};
async function setup(invalidPolicy=false,lifecycleEnabled=false,bufferedCollection=false,intervalMs=10000){
  const relayPolicy=lifecycleEnabled?{...policy,leaseMs:120000n}:policy;
  const base=invalidPolicy?invalidConfig:config,rules=invalidPolicy?invalidReviewed:reviewed;
  const cfg=parseConfig({...base,poll:{...base.poll,intervalMs},
    ...(lifecycleEnabled?{requiredFeedUntil:base.destination!.scheduledT}:{})});
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-pipeline-'));let now=1000100n,chainSeq=0n,chainTime=0n,failSend=false,halted=false;
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
  const relay=new LocalRelay(join(dir,'relay.sqlite'),packets,transport,relayPolicy,()=>now);
  const lifecycle=lifecycleEnabled?new LocalLifecycle(cfg,journal,'lifecycle-fixture',async()=>({
    chainId:31337n,engine:domain.engine,marketId:domain.marketId,sourceId:domain.sourceId,
    engineCodeHash:cfg.destination!.engineCodeHash,rulesHash:domain.rulesHash,scheduledT:BigInt(cfg.destination!.scheduledT),
    halted,blockNumber:now/1000n,blockTimestamp:now/1000n,blockHash:'0x'+(now/1000n).toString(16).padStart(64,'0'),canonical:true}),30000n,()=>now):undefined;
  const snapshots=bufferedCollection?new SourceSnapshotBuffer(worker):undefined;
  const pipeline=new LocalPipeline([{worker:snapshots?{config:cfg,poll:()=>snapshots.poll()}:worker,rules,signer,
    ...(snapshots?{bufferedCollection:true as const,latestSnapshot:()=>snapshots.snapshot()}:{}),
    ...(lifecycle?{lifecycle}:{})}],packets,relay,transport,relayPolicy,()=>now);
  return {dir,domain,packets,journal,signer,relay,pipeline,worker,provider,transport,sent,lifecycle,snapshots,
    halt:()=>{halted=true;},
    setNow:(n:bigint)=>{now=n;},setFail:(v:boolean)=>{failSend=v;},setChain:(s:bigint)=>{chainSeq=s;chainTime=s===0n?0n:1000n;},
    close:()=>{pipeline.close();relay.close();signer.close();packets.close();journal.close();rmSync(dir,{recursive:true,force:true});}};
}
test('joined early-halt recorder sends fresh packets, archives closure as a gap, and never invents a final price',async()=>{
  const s=await setup(true,true);try{
    await s.pipeline.start();assert.equal((await s.pipeline.process(await s.worker.poll())).lifecycle?.mode,'COLLECTING');
    s.setNow(1001100n);s.pipeline.renew();s.halt();
    const recorded=await s.pipeline.process(await s.worker.poll());
    assert.equal(recorded.state,'FINALIZED');assert.equal(recorded.lifecycle?.mode,'RECORD_ONLY');
    assert.equal(s.packets.list(s.domain).length,2);assert.equal(s.sent.length,2);
    s.setNow(1051100n);s.pipeline.renew();
    s.provider.metadata=async()=>({url:'https://fixture.invalid',receivedAtMs:1051100n,latencyMs:0n,attempts:1,
      headers:{},body:JSON.stringify({...metadata,closed:true}),data:{...metadata,closed:true}});
    s.provider.book=async()=>({url:'https://fixture.invalid',receivedAtMs:1051100n,latencyMs:0n,attempts:1,
      headers:{},body:JSON.stringify({...JSON.parse(body),timestamp:'1051000'}),data:{...JSON.parse(body),timestamp:'1051000'}});
    const closed=await s.pipeline.process(await s.worker.poll());
    assert.equal(closed.lifecycle?.mode,'RECORD_ONLY');assert.equal(closed.state,'QUARANTINED');
    assert.equal(closed.reason,'SOURCE_STATUS_CHANGED_REVIEW_REQUIRED');assert.equal(s.packets.list(s.domain).length,2);
    const rejectedMetadata=s.journal.read(s.worker.namespace).at(-1)!.payload.metadata as Record<string,unknown>;
    assert.equal(s.sent.length,2);assert.equal(JSON.parse(String(rejectedMetadata.body)).closed,true);
    assert.equal(s.journal.read(s.worker.namespace).at(-1)!.payload.inspection!==null,true);
    for(const raw of s.sent)assert.equal(decodeFunctionData({abi:INGRESS_ABI,data:parseTransaction(raw).data!}).functionName,'submitObservation');
  }finally{s.close();}
});
test('deadline crossing during signing preserves immutable packet but reserves no nonce and broadcasts nothing',async()=>{
  for(const buffered of [false,true]){
  const s=await setup(false,true,buffered);try{
    s.setNow(100000100n);
    s.provider.book=async()=>({url:'https://fixture.invalid',receivedAtMs:100000050n,latencyMs:0n,attempts:1,
      headers:{},body:JSON.stringify({...JSON.parse(body),timestamp:'100000000'}),data:{...JSON.parse(body),timestamp:'100000000'}});
    const original=s.signer.signDigest.bind(s.signer);
    s.signer.signDigest=async request=>{const signature=await original(request);s.setNow(100001000n);return signature;};
    await s.pipeline.start();const stopped=await s.pipeline.process(await (s.snapshots??s.worker).poll());
    assert.equal(stopped.state,'STOPPED');assert.equal(stopped.lifecycle?.checkpoint?.blockTimestamp,100001n);
    assert.equal(s.packets.list(s.domain).length,1);assert.equal(s.packets.get(s.domain,1n)!.state,'SIGNED');
    assert.equal(s.sent.length,0);assert.equal(s.relay.get(s.domain,1n),null);
  }finally{s.close();}}
});
test('joined scheduler exits a completed recorder without another venue read or new packet',async()=>{
  for(const buffered of [false,true]){
  const s=await setup(false,true,buffered);try{
    s.setNow(100001000n);let reads=0;s.provider.book=async()=>{reads++;throw new Error('must not fetch');};
    await s.pipeline.run(new AbortController().signal,()=>{throw new Error('must not publish');});
    assert.equal(reads,0);assert.equal(s.packets.list(s.domain).length,0);assert.equal(s.sent.length,0);
    assert.equal((await s.lifecycle!.check()).mode,'STOPPED');
  }finally{s.close();}}
});
test('slow relay simulation or transaction signing cannot broadcast across the recording deadline',async()=>{
  for(const buffered of [false,true]){
  for(const phase of ['simulate','prepare'] as const){
    const s=await setup(false,true,buffered,10);try{
      s.setNow(100000100n);
      s.provider.book=async()=>({url:'https://fixture.invalid',receivedAtMs:100000050n,latencyMs:0n,attempts:1,
        headers:{},body:JSON.stringify({...JSON.parse(body),timestamp:'100000000'}),data:{...JSON.parse(body),timestamp:'100000000'}});
      if(phase==='simulate')s.transport.simulate=async()=>{s.setNow(100001000n);};
      else {
        const original=s.transport.prepare;
        s.transport.prepare=async request=>{const raw=await original(request);s.setNow(100001000n);return raw;};
      }
      await s.pipeline.start();assert.equal((await s.pipeline.process(await (s.snapshots??s.worker).poll())).state,'STOPPED');
      assert.equal(s.sent.length,0);assert.equal(s.packets.get(s.domain,1n)!.state,'SIGNED');
      const delivery=s.relay.get(s.domain,1n);
      if(phase==='simulate')assert.equal(delivery,null);
      else {
        assert.equal(delivery!.state,'QUARANTINED');assert.ok(delivery!.raw);
        assert.equal(delivery!.attempts,0);assert.match(delivery!.reason!,/LIFECYCLE_BLOCKED:STOPPED/);
      }
    }finally{s.close();}
  }}
});

test('buffered scheduling removes only the recurring pre-poll gate and retains every signing/send barrier',async()=>{
  for(const buffered of [false,true]){
    const s=await setup(false,true,buffered,10);try{
      const trace:string[]=[],perPass:string[][]=[];
      const check=s.lifecycle!.check.bind(s.lifecycle!);
      s.lifecycle!.check=async()=>{trace.push('gate');return check();};
      const sign=s.signer.signDigest.bind(s.signer);
      s.signer.signDigest=async request=>{trace.push('observation-sign');return sign(request);};
      const simulate=s.transport.simulate,prepare=s.transport.prepare,broadcast=s.transport.broadcast;
      s.transport.simulate=async(...args)=>{trace.push('simulate');return simulate(...args);};
      s.transport.prepare=async request=>{trace.push('transaction-sign');return prepare(request);};
      s.transport.broadcast=async raw=>{trace.push('broadcast');return broadcast(raw);};
      const stop=new AbortController();
      await s.pipeline.run(stop.signal,result=>{
        assert.equal(result.state,'FINALIZED');perPass.push(trace.splice(0));
        if(perPass.length===2)stop.abort();
      });
      const barriers=['gate','observation-sign','gate','simulate','gate','transaction-sign','gate','broadcast'];
      assert.deepEqual(perPass[0],['gate',...barriers]); // Bootstrap still checks before poll.
      assert.deepEqual(perPass[1],buffered?barriers:['gate',...barriers]);
      assert.equal(s.sent.length,2);assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),[0,1]);
    }finally{s.close();}
  }
});

test('a quarantined buffered source still checks its deadline and exits without signing',async()=>{
  const s=await setup(false,true,true,10);try{
    s.setNow(100000100n);
    s.provider.book=async()=>{throw Error('BOOK_IDENTITY_MISMATCH');};
    const results:string[]=[];let checks=0;
    const check=s.lifecycle!.check.bind(s.lifecycle!);
    s.lifecycle!.check=async()=>{checks++;return check();};
    await s.pipeline.run(AbortSignal.timeout(5000),result=>{
      results.push(result.state);s.setNow(100001000n);
    });
    assert.deepEqual(results,['QUARANTINED','STOPPED']);
    assert.equal(checks,3); // Initial gate, quarantined pass, terminal pass.
    assert.equal(s.sent.length,0);assert.equal(s.packets.list(s.domain).length,0);
  }finally{s.close();}
});

test('buffered terminal pass reconciles the exact pending receipt before stopping without a new send',async()=>{
  const s=await setup(false,true,true,10);try{
    s.setNow(100000100n);
    const data={...JSON.parse(body),timestamp:'100000000'};
    s.provider.book=async()=>({url:'fixture://fresh',receivedAtMs:100000050n,latencyMs:1n,
      body:JSON.stringify(data),headers:{},data,attempts:1});
    const receipt=s.transport.receipt;
    let receiptVisible=false,receiptReads=0;
    s.transport.receipt=async hash=>{receiptReads++;return receiptVisible?receipt(hash):null;};
    const results:string[]=[];
    await s.pipeline.run(AbortSignal.timeout(5000),result=>{
      results.push(result.state);
      if(results.length===1){assert.equal(result.state,'UNKNOWN');receiptVisible=true;s.setNow(100001000n);}
    });
    assert.deepEqual(results,['UNKNOWN','FINALIZED','STOPPED']);assert.ok(receiptReads>=2);
    assert.equal(s.relay.get(s.domain,1n)!.state,'FINALIZED');
    assert.equal(s.sent.length,1);assert.equal(s.packets.list(s.domain).length,1);
  }finally{s.close();}
});
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
