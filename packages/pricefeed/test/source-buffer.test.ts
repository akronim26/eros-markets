import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { SourceSnapshotBuffer } from '../src/source-buffer.js';
import { config } from './publication-fixture.js';
import { json } from '../src/math.js';
import type { PollResult } from '../src/worker.js';

const cfg={...config,poll:{...config.poll,intervalMs:5}};
const make=(at:bigint,status:PollResult['inspection']['status']='COLLECTING'):PollResult=>({worker:cfg.key,category:cfg.category,
  configDigest:createHash('sha256').update(json(cfg)).digest('hex'),atMs:at,
  inspection:{status,reason:status==='DEGRADED'?'SOURCE_TIMEOUT':null,time:null,summary:null,engineObservation:null},
  event:null,metadata:null,book:null,baselineRulesDigest:null,lastSourceMs:at});
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test('source collection advances while a publication is held, with only one frozen latest result',async()=>{
  let polls=0,active=0,maxActive=0;const stop=new AbortController();
  const buffer=new SourceSnapshotBuffer({config:cfg,poll:async()=>{active++;maxActive=Math.max(maxActive,active);
    await pause(1);active--;return make(BigInt(++polls));}});
  const run=buffer.run(stop.signal);
  try{
    await pause(15);const first=buffer.snapshot()!;assert.ok(first);
    // An unrelated publisher can remain pending without holding collection.
    await pause(35);const second=buffer.snapshot()!;
    assert.ok(second.atMs>first.atMs);assert.ok(polls>=4);assert.equal(maxActive,1);
    second.atMs=0n;assert.notEqual(buffer.snapshot()!.atMs,0n);
    assert.equal(first.atMs,first.lastSourceMs,'old snapshot was mutated');
  }finally{stop.abort();await run;}
});
test('a degraded capture replaces healthy data instead of replaying cached health',async()=>{
  let status:PollResult['inspection']['status']='COLLECTING';
  const buffer=new SourceSnapshotBuffer({config:cfg,poll:async()=>make(1000n,status)});
  assert.equal((await buffer.poll()).inspection.status,'COLLECTING');
  const stop=new AbortController();status='DEGRADED';
  const run=buffer.run(stop.signal);await pause(10);stop.abort();await run;
  assert.equal(buffer.snapshot()!.inspection.status,'DEGRADED');
  assert.equal(buffer.snapshot()!.inspection.reason,'SOURCE_TIMEOUT');
});
test('foreign worker/config and fatal collection failures invalidate the buffered healthy result',async()=>{
  for(const changed of [{...make(2n),worker:'foreign'},{...make(2n),configDigest:'bad'},null]){
    let calls=0;const buffer=new SourceSnapshotBuffer({config:cfg,poll:async()=>{
      if(calls++===0)return make(1n);if(changed===null)throw new Error('JOURNAL_FENCE_LOST');return changed;
    }});
    await buffer.poll();
    await assert.rejects(buffer.run(new AbortController().signal),/SOURCE_SNAPSHOT_BINDING_MISMATCH|JOURNAL_FENCE_LOST/);
    assert.throws(()=>buffer.snapshot());
  }
});
test('shutdown drains an in-flight capture and rejects a second producer loop',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>release=r),stop=new AbortController();let drained=false;
  const buffer=new SourceSnapshotBuffer({config:cfg,poll:async()=>{await hold;drained=true;return make(7n);}});
  const run=buffer.run(stop.signal);await assert.rejects(buffer.run(stop.signal),/ALREADY_RUNNING/);
  stop.abort();await pause(5);assert.equal(drained,false);release();await run;
  assert.equal(drained,true);assert.equal(buffer.snapshot()!.atMs,7n);
});
