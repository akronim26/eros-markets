import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { LocalLifecycle, type LifecycleCheckpoint } from '../src/lifecycle.js';
import { Journal } from '../src/journal.js';
import { config, h } from './publication-fixture.js';
import { CollectionService } from '../src/service.js';
import { healthView } from '../src/health.js';

const cfg={...config,requiredFeedUntil:config.destination!.scheduledT};
function checkpoint(t=1000n,n=1n,halted=false):LifecycleCheckpoint {
  const d=cfg.destination!;
  return {chainId:31337n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,
    engineCodeHash:d.engineCodeHash,rulesHash:d.sourceRulesHash,scheduledT:BigInt(d.scheduledT),halted,
    blockNumber:n,blockHash:'0x'+n.toString(16).padStart(64,'0'),blockTimestamp:t,canonical:true};
}
function setup(){
  const journal=new Journal(':memory:');let at=1000100n,c=checkpoint(),failure:Error|null=null;
  const read=async()=>{if(failure)throw failure;return c;};
  const make=()=>new LocalLifecycle(cfg,journal,'lifecycle-test',read,30000n,()=>at);
  return {journal,read,make,set:(t:bigint,n:bigint,halted=false)=>{at=t*1000n+100n;c=checkpoint(t,n,halted);},
    change:(p:Partial<LifecycleCheckpoint>)=>{c={...c,...p};},clock:(n:bigint)=>{at=n;},fail:(e:Error|null)=>{failure=e;}};
}
test('early halt remains record-only through T, exact T is included, stop survives restart/clock rollback',async()=>{
  const s=setup();try{
    let lifecycle=s.make();assert.equal((await lifecycle.check()).mode,'COLLECTING');
    s.set(1001n,2n,true);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    lifecycle=s.make();assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    s.set(99999n,3n,true);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    s.set(100000n,4n,true);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    s.set(100001n,5n,true);assert.equal((await lifecycle.check()).mode,'STOPPED');
    lifecycle=s.make();s.set(1000n,1n,false);assert.equal((await lifecycle.check()).mode,'STOPPED');
    assert.equal(s.journal.verify(),true);assert.equal(s.journal.read(lifecycle.namespace).length,6);
  }finally{s.journal.close();}
});
test('explicit later recording horizon and scheduled halt need no oracle decision',async()=>{
  const s=setup();try{
    const later={...cfg,requiredFeedUntil:'100030'};
    const lifecycle=new LocalLifecycle(later,s.journal,'owner',s.read,30000n,()=>100030100n);
    s.set(100030n,1n);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    assert.equal((await lifecycle.check()).reason,'SCHEDULED_T_REACHED');
    assert.throws(()=>new LocalLifecycle({...cfg,requiredFeedUntil:'99999'},s.journal,'owner',s.read,30000n),/HORIZON/);
    assert.throws(()=>new LocalLifecycle({...cfg,requiredFeedUntil:null},s.journal,'owner',s.read,30000n),/HORIZON/);
  }finally{s.journal.close();}
});
test('RPC outage/stale/future blocks fail closed; authentic recovery preserves halted state',async()=>{
  const s=setup();try{
    const lifecycle=s.make();s.set(1000n,1n,true);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    s.fail(new Error('RPC_TIMEOUT'));assert.equal((await lifecycle.check()).mode,'DEGRADED');
    s.fail(null);s.clock(1031000n);assert.equal((await lifecycle.check()).mode,'DEGRADED');
    s.set(1032n,2n,true);s.clock(1031000n);assert.equal((await lifecycle.check()).mode,'DEGRADED');
    s.set(1032n,2n,true);assert.equal((await lifecycle.check()).mode,'RECORD_ONLY');
    assert.equal(s.journal.read(lifecycle.namespace).length,5);
  }finally{s.journal.close();}
});
test('wrong pins, reorg, backwards block, inconsistent block and disappearing halt persist quarantine',async()=>{
  const changes:Partial<LifecycleCheckpoint>[]=[{chainId:143n},{engine:h('12').slice(0,42)},
    {marketId:h('12')},{sourceId:h('12')},{rulesHash:h('12')},{engineCodeHash:h('12')},
    {scheduledT:100001n},{canonical:false},{blockHash:h('bb')},{blockNumber:0n},
    {blockTimestamp:1001n},{halted:false},{blockHash:'bad'}];
  for(const change of changes){
    const s=setup();try{
      let lifecycle=s.make();s.set(1000n,1n,true);await lifecycle.check();
      s.change(change);assert.equal((await lifecycle.check()).mode,'QUARANTINED',JSON.stringify(change,(_k,v)=>typeof v==='bigint'?String(v):v));
      lifecycle=s.make();s.set(1001n,2n,true);assert.equal((await lifecycle.check()).mode,'QUARANTINED');
    }finally{s.journal.close();}
  }
});
test('checks coalesce, returned evidence cannot mutate trusted state, config changes require review',async()=>{
  const s=setup();try{
    const lifecycle=s.make();const a=lifecycle.check(),b=lifecycle.check();assert.equal(a,b);
    const result=await a;result.checkpoint!.halted=true;
    assert.equal((await lifecycle.check()).mode,'COLLECTING');
    assert.throws(()=>lifecycle.assertConfig({...cfg,key:'different'}),/CONFIG_MISMATCH/);
    assert.throws(()=>new LocalLifecycle(cfg,s.journal,'owner',s.read,1000n),/POLICY_CHANGED/);
    assert.throws(()=>new LocalLifecycle({...cfg,key:'different'},s.journal,'owner',s.read,30000n),/CONFIG_CHANGED/);
    assert.throws(()=>new LocalLifecycle({...cfg,destination:{...cfg.destination!,chainId:'143'}},s.journal,'owner',s.read,30000n),/LOCAL_DISABLED_CONFIG_ONLY/);
  }finally{s.journal.close();}
});
test('corrupt archive and expired writer cannot grant publication permission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-lifecycle-'));const path=join(dir,'lifecycle.sqlite');
  const journal=new Journal(path);let at=1000100n;
  try{
    const lifecycle=new LocalLifecycle(cfg,journal,'owner',async()=>checkpoint(),30000n,()=>at);await lifecycle.check();
    const db=new DatabaseSync(path);db.prepare('UPDATE captures SET sha256=?').run('corrupt');db.close();
    assert.throws(()=>new LocalLifecycle(cfg,journal,'owner',async()=>checkpoint(),30000n,()=>at),/ARCHIVE_CORRUPT/);
    const other=new Journal(':memory:');try{
      const slow=new LocalLifecycle(cfg,other,'owner',async()=>{at+=60001n;return checkpoint();},30000n,()=>at);
      await assert.rejects(slow.check(),/WRITER_FENCED/);assert.equal(other.workers().length,0);
    }finally{other.close();}
  }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('stopped market leaves the scheduler without fetching and does not stop another market',async()=>{
  let fetched=0,other=0;const stop=new AbortController();
  await new CollectionService([
    {config:{key:'stopped',poll:{intervalMs:1}},shouldPoll:async()=>false,poll:async()=>{fetched++;throw new Error('must not fetch');}},
    {config:{key:'active',poll:{intervalMs:1}},poll:async()=>{other++;return {worker:'active',category:'sports',atMs:1n,configDigest:'fixture',
      inspection:{status:'DEGRADED',reason:'fixture',time:null,summary:null,engineObservation:null},
      event:null,metadata:null,book:null,baselineRulesDigest:null,lastSourceMs:null};}},
  ]).run(stop.signal,()=>{if(other===3)stop.abort();});
  assert.equal(fetched,0);assert.equal(other,3);
});
test('read-only health recognizes lifecycle records and recalculates checkpoint freshness',async()=>{
  const s=setup();try{
    const lifecycle=s.make();await lifecycle.check();
    let payload=s.journal.latest(lifecycle.namespace)!.payload;
    let health=healthView(payload,1000100n);
    assert.equal(health.worker,cfg.key);assert.equal(health.currentStatus,'COLLECTING');
    assert.equal(health.freshAtQuery,true);assert.equal(health.operationalOutput,false);
    health=healthView(payload,1031000n);
    assert.equal(health.currentStatus,'DEGRADED');assert.equal(health.freshAtQuery,false);
    assert.equal(health.currentReason,'LIFECYCLE_CHECKPOINT_STALE_AT_QUERY');
    s.set(100001n,2n,true);await lifecycle.check();payload=s.journal.latest(lifecycle.namespace)!.payload;
    assert.equal(healthView(payload,100100000n).currentStatus,'STOPPED');
  }finally{s.journal.close();}
});
