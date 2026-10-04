import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectionService, RefreshSignal, type ScheduledWorker } from '../src/service.js';
import type { PollResult } from '../src/worker.js';

const result=(worker:string):PollResult=>({worker,category:'sports',atMs:1n,configDigest:'fixture',
  inspection:{status:'DEGRADED',reason:'fixture outage',time:null,summary:null,engineObservation:null},
  event:null,metadata:null,book:null,baselineRulesDigest:null,lastSourceMs:null});
test('continuous collection isolates slow worker, never overlaps a poll, and abort wakes long timers',async()=>{
  const stop=new AbortController();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,fast=0,slow=0;
  const workers:ScheduledWorker[]=[
    {config:{key:'slow',poll:{intervalMs:60000}},poll:async()=>{slow++;await gate;return result('slow');}},
    {config:{key:'fast',poll:{intervalMs:1}},poll:async()=>{assert.equal(active++,0);await Promise.resolve();active--;fast++;return result('fast');}},
  ];
  const service=new CollectionService(workers);
  const run=service.run(stop.signal,r=>{assert.equal(r.inspection.engineObservation,null);if(fast>=3){stop.abort();release();}});
  await assert.rejects(service.run(stop.signal,()=>{}),/ALREADY_RUNNING/);
  await run;assert.ok(fast>=3);assert.equal(slow,1);
  const before=fast;await service.run(stop.signal,()=>{});assert.equal(fast,before);
});
test('journal/callback failure stops the service and drains running polls before returning',async()=>{
  const signal=new AbortController();let drained=false;
  const workers:ScheduledWorker[]=[
    {config:{key:'broken',poll:{intervalMs:60000}},poll:async()=>{throw new Error('WRITER_FENCED');}},
    {config:{key:'other',poll:{intervalMs:60000}},poll:async()=>{await Promise.resolve();drained=true;return result('other');}},
  ];
  await assert.rejects(new CollectionService(workers).run(signal.signal,()=>{}),/WRITER_FENCED/);
  assert.equal(drained,true);
  await assert.rejects(new CollectionService([workers[1]!]).run(signal.signal,()=>{throw new Error('consumer failed');}),/consumer failed/);
  assert.throws(()=>new CollectionService([workers[0]!,workers[0]!]),/WORKERS/);
});
test('stream hint bursts coalesce, respect minimum spacing and do not hold a quiet worker',async()=>{
  const refresh=new RefreshSignal(20),stop=new AbortController();const starts:number[]=[];let quiet=0,active=0;
  const workers:ScheduledWorker[]=[{config:{key:'hinted',poll:{intervalMs:60000}},refresh,poll:async()=>{
    assert.equal(active++,0);starts.push(performance.now());
    // A thousand events during a request occupy one pending refresh, not a thousand polls.
    for(let i=0;i<1000;i++)refresh.request(1);
    await new Promise(resolve=>setTimeout(resolve,3));active--;return result('hinted');}},
    {config:{key:'quiet',poll:{intervalMs:5}},poll:async()=>{quiet++;return result('quiet');}}];
  await new CollectionService(workers).run(stop.signal,r=>{if(r.worker==='hinted'&&starts.length===3)stop.abort();});
  assert.equal(starts.length,3);assert.ok(quiet>=3);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]!-starts[i-1]!>=15);
});
test('lost hints and heartbeat silence never disable periodic complete polling',async()=>{
  const refresh=new RefreshSignal(1000),stop=new AbortController();let polls=0;
  await new CollectionService([{config:{key:'quiet',poll:{intervalMs:5}},refresh,
    poll:async()=>{polls++;return result('quiet');}}]).run(stop.signal,()=>{if(polls===4)stop.abort();});
  assert.equal(polls,4);assert.throws(()=>new RefreshSignal(0));
});
