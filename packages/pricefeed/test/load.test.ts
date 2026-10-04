import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransaction } from 'viem';
import { CollectionService } from '../src/service.js';
import { loadFixture, gate, until } from './load-fixture.js';

test('25-market collection remains independent when one book stalls, with no overlapping polls',async()=>{
  const s=loadFixture(25,{sourceDelayMs:1}),slow=gate(),stop=new AbortController();let running:Promise<void>|undefined;
  try{
    s.onSource(async(index,phase)=>{if(index===0&&phase==='book')await slow.promise;});
    running=new CollectionService(s.workers).run(stop.signal,()=>{
      if(s.stats.perWorkerPolls.slice(1).every(n=>n>=2)){stop.abort();slow.release();}
    });await running;
    assert.equal(s.stats.perWorkerPolls[0],1);assert.ok(s.stats.perWorkerPolls.slice(1).every(n=>n>=2));
    assert.ok(s.stats.maxBookActive.every(n=>n===1));assert.equal(s.stats.sourceActive,0);
    assert.ok(s.workers.every(w=>s.journal.read(w.namespace).length>=1));assert.equal(s.journal.verify(),true);
    console.log('LOAD_CASE '+JSON.stringify({scenario:'independent-collection',...s.report()}));
  }finally{stop.abort();slow.release();await running;s.close();}
});

test('25 markets across three categories share ordered nonces through two slow-RPC publication rounds',async()=>{
  const s=loadFixture(25,{sourceDelayMs:1,rpcDelayMs:3});try{
    await s.pipeline.start();
    for(let round=0;round<2;round++){
      const snapshots=await Promise.all(s.workers.map(w=>w.poll()));
      const outputs=await Promise.all(snapshots.map(snapshot=>s.pipeline.process(snapshot)));
      assert.ok(outputs.every(o=>o.state==='FINALIZED'));assert.ok(outputs.every(o=>o.sequence===BigInt(round+1)));
    }
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),Array.from({length:50},(_,i)=>i));
    assert.equal(s.stats.maxRpcActive,1);assert.ok(s.entries.every(e=>e.signer.reservations().length===2));
    assert.ok(s.entries.every(e=>s.packets.list(e.domain).length===2));
    assert.equal(s.stats.headroomAtBroadcastMs.length,50);assert.ok(s.stats.headroomAtBroadcastMs.every(ms=>BigInt(ms)>=1000n));
    console.log('LOAD_CASE '+JSON.stringify({scenario:'slow-rpc-two-rounds',...s.report()}));
  }finally{s.close();}
});

test('queue-expired unsent updates return EXPIRED without consuming nonces, and fresh updates resume',async()=>{
  const s=loadFixture(12),slow=gate(),entered=gate();let pending:Promise<PromiseSettledResult<unknown>[]>|undefined;
  try{
    await s.pipeline.start();let first=true;
    s.onRpc(async phase=>{if(phase==='simulate'&&first){first=false;entered.release();await slow.promise;}});
    const snapshots=await Promise.all(s.workers.map(w=>w.poll()));
    pending=Promise.allSettled(snapshots.map(snapshot=>s.pipeline.process(snapshot)));
    await entered.promise;await until(()=>s.entries.every(e=>s.packets.get(e.domain,1n)?.state==='SIGNED'));
    const original=s.entries.map(e=>s.packets.get(e.domain,1n)!);
    s.advance(31000n);s.pipeline.renew();slow.release();const settled=await pending;
    assert.ok(settled.every(r=>r.status==='fulfilled'),JSON.stringify(settled.map(r=>r.status)));
    const outputs=settled.map(r=>(r as PromiseFulfilledResult<{state:string}>).value);
    assert.ok(outputs.every(o=>o.state==='EXPIRED'));assert.equal(s.sent.length,0);
    s.entries.forEach((e,i)=>{
      const expired=s.packets.get(e.domain,1n)!;assert.equal(expired.state,'EXPIRED');
      assert.deepEqual(expired.packet,original[i]!.packet);assert.equal(expired.signature,original[i]!.signature);
      assert.equal(s.relay.get(e.domain,1n),null);
    });
    s.onRpc(async()=>{});
    const fresh=await Promise.all(s.workers.map(w=>w.poll()));
    const resumed=await Promise.all(fresh.map(snapshot=>s.pipeline.process(snapshot)));
    assert.ok(resumed.every(r=>r.state==='FINALIZED'&&r.sequence===2n));
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),Array.from({length:12},(_,i)=>i));
    console.log('LOAD_CASE '+JSON.stringify({scenario:'queued-expiry-and-recovery',injectedDelayMs:31000,...s.report()}));
  }finally{slow.release();await pending;s.close();}
});

test('RPC simulation timeout allocates no nonce and late completion cannot broadcast',async()=>{
  const s=loadFixture(3),slow=gate();try{
    await s.pipeline.start();s.onRpc(async phase=>{if(phase==='simulate')await slow.promise;});
    const snapshot=await s.workers[0]!.poll();await assert.rejects(s.pipeline.process(snapshot),/RELAY_TIMEOUT/);
    assert.equal(s.relay.get(s.entries[0]!.domain,1n),null);assert.equal(s.sent.length,0);
    slow.release();await until(()=>s.stats.rpcActive===0);assert.equal(s.sent.length,0);
    s.onRpc(async()=>{});const retried=await s.pipeline.process(await s.workers[0]!.poll());
    assert.equal(retried.state,'FINALIZED');assert.equal(retried.sequence,1n);assert.equal(parseTransaction(s.sent[0]!).nonce,0);
    console.log('LOAD_CASE '+JSON.stringify({scenario:'rpc-timeout-late-completion',...s.report()}));
  }finally{slow.release();s.close();}
});

test('continuous joined service survives shared-queue expiry and continues with fresh source captures',async()=>{
  const s=loadFixture(8),slow=gate(),entered=gate(),stop=new AbortController();
  const accepted=new Set<string>(),states:string[]=[];let running:Promise<void>|undefined;
  try{
    let first=true;s.onRpc(async phase=>{if(phase==='simulate'&&first){first=false;entered.release();await slow.promise;}});
    running=s.pipeline.run(stop.signal,result=>{
      states.push(result.state);if(result.state==='FINALIZED')accepted.add(result.worker);
      if(accepted.size===8)stop.abort();
    });
    await entered.promise;await until(()=>s.workers.every(w=>s.journal.latest(w.namespace)!==null));
    s.advance(31000n);s.pipeline.renew();slow.release();await running;
    assert.ok(states.includes('EXPIRED'));assert.equal(accepted.size,8);
    assert.ok(s.stats.maxBookActive.every(n=>n===1));assert.equal(s.stats.sourceActive,0);
    assert.deepEqual(s.sent.map(raw=>parseTransaction(raw).nonce),s.sent.map((_raw,i)=>i));
    console.log('LOAD_CASE '+JSON.stringify({scenario:'continuous-queue-expiry',injectedDelayMs:31000,expired:states.filter(state=>state==='EXPIRED').length,...s.report()}));
  }finally{stop.abort();slow.release();await running;s.close();}
});

test('provider queue pressure archives truthful gaps and workers recover after the burst drains',async()=>{
  const s=loadFixture(20,{sourceDelayMs:1,maxPending:4});try{
    const burst=await Promise.all(s.workers.map(w=>w.poll()));
    assert.ok(burst.some(p=>p.inspection.reason==='PROVIDER_QUEUE_FULL'));
    assert.ok(s.workers.every(w=>s.journal.read(w.namespace).length===1));
    for(const worker of s.workers)assert.equal((await worker.poll()).inspection.status,'COLLECTING');
    assert.equal(s.journal.verify(),true);assert.equal(s.sent.length,0);
    console.log('LOAD_CASE '+JSON.stringify({scenario:'provider-backpressure',degradedDuringBurst:burst.filter(p=>p.inspection.status!=='COLLECTING').length,...s.report()}));
  }finally{s.close();}
});

test('100-worker collection drains all admitted work and shutdown wakes long poll timers',async()=>{
  const s=loadFixture(100),stop=new AbortController();try{
    let completed=0;
    const workers=s.workers.map(w=>({config:{key:w.config.key,poll:{intervalMs:60000}},poll:()=>w.poll()}));
    await new CollectionService(workers).run(stop.signal,()=>{if(++completed===100)stop.abort();});
    assert.equal(completed,100);assert.ok(s.stats.perWorkerPolls.every(n=>n===1));
    assert.equal(s.stats.sourceActive,0);assert.equal(s.journal.verify(),true);
    assert.throws(()=>new CollectionService([...workers,{...workers[0]!,config:{key:'overflow',poll:{intervalMs:1}}}]),/BAD_SERVICE_WORKERS/);
    console.log('LOAD_CASE '+JSON.stringify({scenario:'100-worker-drain',...s.report()}));
  }finally{stop.abort();s.close();}
});
