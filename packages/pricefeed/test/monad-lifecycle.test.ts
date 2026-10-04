import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { keccak256, type Hex } from 'viem';
import { Journal } from '../src/journal.js';
import { LocalLifecycle, MonadTestnetLifecycleMonitor } from '../src/lifecycle.js';
import { monadLifecycleReader, watchMonadLifecycle } from '../src/monad-lifecycle.js';
import { parseEngineReadAbi, type MonadReadRpc } from '../src/monad-preflight.js';
import { healthView } from '../src/health.js';
import { config, h } from './publication-fixture.js';

const abi:unknown=JSON.parse(readFileSync(new URL('../../../../artifacts/risk/engine-abi.json',import.meta.url),'utf8'));
const code='0x60006000' as Hex;
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-monad-lifecycle-')),path=join(dir,'lifecycle.sqlite');
  let journal=new Journal(path),now=1000100n,t=1000n,n=10n,halted=false,chain=10143,fail=false,calls=0;
  const cfg={...structuredClone(config),requiredFeedUntil:'100030'};
  cfg.destination={...cfg.destination!,chainId:'10143',abiHash:parseEngineReadAbi(abi).abiHash,engineCodeHash:keccak256(code)};
  const d=cfg.destination,state={signer:d.signerAddress,rulesHash:d.sourceRulesHash,lastSequence:5n,lastObservedAt:990n,configured:true};
  const listing={...d,indexSourceId:d.sourceId,indexSigner:d.signerAddress,indexRulesHash:d.sourceRulesHash,
    depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad};
  const rpc:MonadReadRpc={
    chainId:async()=>{calls++;if(fail)throw new Error('https://rpc.invalid/private-secret');return chain;},
    block:async(selector)=>({number:'blockNumber' in selector?selector.blockNumber:n,
      timestamp:t,hash:('0x'+n.toString(16).padStart(64,'0')) as Hex}),
    code:async()=>code,
    read:async(_engine,_abi,name)=>name==='listing'?listing:name==='sourceState'?state:halted,
  };
  const reader=monadLifecycleReader(rpc,cfg,abi,()=>now);
  return {cfg,state,listing,rpc,path,reader,get journal(){return journal;},clock:()=>now,
    make:()=>new MonadTestnetLifecycleMonitor(cfg,journal,'fixture-owner',reader,30000n,()=>now),
    set:(time:bigint,number:bigint,halt=false)=>{t=time;n=number;halted=halt;now=time*1000n+100n;},
    setNow:(time:bigint)=>{now=time;},setChain:(id:number)=>{chain=id;},fail:(value:boolean)=>{fail=value;},calls:()=>calls,
    reopen:()=>{journal.close();journal=new Journal(path);},close:()=>{journal.close();rmSync(dir,{recursive:true,force:true});}};
}

test('Monad monitor persists early halt through restart, includes T/later horizon and remembers terminal stop',async()=>{
  const f=setup();try{
    let monitor=f.make();assert.equal((await monitor.check()).mode,'COLLECTING');assert.equal(monitor.readOnly,true);
    f.set(1001n,11n,true);assert.equal((await monitor.check()).mode,'RECORD_ONLY');
    f.reopen();monitor=f.make();assert.equal((await monitor.check()).mode,'RECORD_ONLY');
    f.set(100000n,12n,true);assert.equal((await monitor.check()).mode,'RECORD_ONLY');
    f.set(100030n,13n,true);assert.equal((await monitor.check()).mode,'RECORD_ONLY');
    f.set(100031n,14n,true);assert.equal((await monitor.check()).mode,'STOPPED');
    f.reopen();monitor=f.make();f.set(1000n,10n);const before=f.calls();
    assert.equal((await monitor.check()).mode,'STOPPED');assert.equal(f.calls(),before);
    assert.equal(f.journal.verify(),true);
  }finally{f.close();}
});

test('Monad outage is archived with redacted reason and retains prior halt; fresh recovery resumes recording',async()=>{
  const f=setup();try{
    let monitor=f.make();f.set(1001n,11n,true);await monitor.check();f.fail(true);
    const degraded=await monitor.check();assert.equal(degraded.mode,'DEGRADED');assert.equal(degraded.reason,'LIFECYCLE_RPC_UNAVAILABLE');
    assert.equal(degraded.checkpoint!.halted,true);assert.equal(degraded.freshCheckpoint,false);
    assert.ok(!JSON.stringify(f.journal.read(monitor.namespace),(_k,v)=>typeof v==='bigint'?String(v):v).includes('private-secret'));
    f.reopen();monitor=f.make();f.fail(false);f.set(1002n,12n,true);
    assert.equal((await monitor.check()).mode,'RECORD_ONLY');
  }finally{f.close();}
});

test('Monad disappearing halt is permanently quarantined across database reopen',async()=>{
  const f=setup();try{
    let monitor=f.make();f.set(1001n,11n,true);await monitor.check();f.set(1002n,12n,false);
    const result=await monitor.check();assert.equal(result.mode,'QUARANTINED');assert.equal(result.reason,'LIFECYCLE_HALT_REGRESSION');
    f.reopen();monitor=f.make();f.set(1003n,13n,true);assert.equal((await monitor.check()).mode,'QUARANTINED');
  }finally{f.close();}
});

test('Monad finalized source progress persists across reopen and a sequence/time regression cannot be cleared by retry',async()=>{
  for(const change of [{lastSequence:4n},{lastObservedAt:989n}]){
    const f=setup();try{
      await f.make().check();f.reopen();const monitor=f.make();f.set(1001n,11n);Object.assign(f.state,change);
      const r=await monitor.check();assert.equal(r.mode,'QUARANTINED');assert.equal(r.reason,'LIFECYCLE_SOURCE_REGRESSION');
      f.state.lastSequence=6n;f.state.lastObservedAt=991n;f.set(1002n,12n);
      assert.equal((await monitor.check()).mode,'QUARANTINED');
    }finally{f.close();}
  }
});

test('Monad same-block changed state and same-sequence changed observedAt are contradictory',async()=>{
  for(const sameBlock of [true,false]){
    const f=setup();try{
      const monitor=f.make();await monitor.check();if(sameBlock)f.state.lastSequence=6n;else f.set(1001n,11n);
      f.state.lastObservedAt=991n;const r=await monitor.check();
      assert.equal(r.mode,'QUARANTINED');assert.equal(r.reason,'LIFECYCLE_SOURCE_CHANGED');
    }finally{f.close();}
  }
});

test('Monad newer sequence may retain the original observedAt and health recalculates checkpoint freshness',async()=>{
  const f=setup();try{
    const monitor=f.make();await monitor.check();f.set(1001n,11n);f.state.lastSequence=6n;
    const r=await monitor.check();assert.equal(r.mode,'COLLECTING');assert.equal(r.checkpoint!.sourceState!.lastObservedAt,990n);
    const payload=f.journal.latest(monitor.namespace)!.payload;
    assert.equal(healthView(payload,1001100n).currentStatus,'COLLECTING');
    assert.equal(healthView(payload,1031001n).currentStatus,'DEGRADED');
    assert.equal(healthView(payload,1031001n).operationalOutput,false);
  }finally{f.close();}
});

test('Monad wrong chain, changed code/listing/source identity and missing source quarantine rather than recover as outages',async()=>{
  for(const change of ['chain','code','listing','signer','rules','missing'] as const){
    const f=setup();try{
      const monitor=f.make();await monitor.check();f.set(1001n,11n);
      if(change==='chain')f.setChain(143);
      if(change==='code')f.rpc.code=async()=> '0x6001';
      if(change==='listing')f.listing.marketId=h('ff');
      if(change==='signer')f.state.signer='0x'+'33'.repeat(20);
      if(change==='rules')f.state.rulesHash=h('ff') as Hex;
      if(change==='missing')f.state.configured=false;
      const r=await monitor.check();assert.equal(r.mode,'QUARANTINED');assert.equal(r.reason,'LIFECYCLE_PIN_MISMATCH');
    }finally{f.close();}
  }
});

test('Monad stale checkpoints degrade, while canonical disagreement and malformed source facts quarantine',async()=>{
  const f=setup();try{
    const monitor=f.make();await monitor.check();f.setNow(1030001n);
    assert.equal((await monitor.check()).mode,'DEGRADED');f.set(1031n,11n);assert.equal((await monitor.check()).mode,'COLLECTING');
    const block=f.rpc.block;f.rpc.block=async(selector)=>({...await block(selector),...('blockNumber' in selector?{hash:h('ff') as Hex}:{})});
    assert.equal((await monitor.check()).reason,'LIFECYCLE_REORG');
  }finally{f.close();}
  const g=setup();try{g.state.lastObservedAt=1001n;assert.equal((await g.make().check()).mode,'QUARANTINED');}finally{g.close();}
});

test('Monad monitor refuses incompatible horizons/domains and leaves the local publication gate chain-31337-only',()=>{
  const f=setup();try{
    for(const requiredFeedUntil of [null,'99999'])assert.throws(()=>monadLifecycleReader(f.rpc,{...f.cfg,requiredFeedUntil},abi),/HORIZON/);
    assert.throws(()=>monadLifecycleReader(f.rpc,{...f.cfg,destination:{...f.cfg.destination!,chainId:'143'}},abi),/MONAD_DISABLED_TESTNET_CONFIG_REQUIRED/);
    assert.throws(()=>new LocalLifecycle(f.cfg,f.journal,'owner',f.reader,30000n),/LOCAL_DISABLED_CONFIG_ONLY/);
    assert.throws(()=>new MonadTestnetLifecycleMonitor({...f.cfg,destination:{...f.cfg.destination!,chainId:'31337'}},f.journal,'owner',f.reader,30000n),/MONAD_DISABLED_TESTNET_CONFIG_REQUIRED/);
    assert.throws(()=>monadLifecycleReader(f.rpc,{...f.cfg,destination:{...f.cfg.destination!,abiHash:h('ff') as Hex}},abi),/MONAD_ABI_PIN_MISMATCH/);
  }finally{f.close();}
});

test('Monad reader snapshots inputs; persisted config/policy changes and corrupt journals prevent startup',async()=>{
  const f=setup();try{
    const monitor=f.make();f.cfg.destination!.sourceRulesHash=h('ff') as Hex;
    // Reader and controller both hold the original dossier, despite caller mutation.
    assert.equal((await monitor.check()).mode,'COLLECTING');
    assert.throws(f.make,/LIFECYCLE_CONFIG_CHANGED/);
    f.cfg.destination!.sourceRulesHash=f.state.rulesHash;
    assert.throws(()=>new MonadTestnetLifecycleMonitor(f.cfg,f.journal,'owner',f.reader,1000n,f.clock),/LIFECYCLE_POLICY_CHANGED/);
    const db=new DatabaseSync(f.path);db.prepare('UPDATE captures SET sha256=?').run('corrupt');db.close();
    assert.throws(f.make,/LIFECYCLE_ARCHIVE_CORRUPT/);
  }finally{f.close();}
});

test('Monad expired writer cannot append an outage or grant a fresh lifecycle view',async()=>{
  const f=setup();try{
    f.rpc.chainId=async()=>{f.setNow(1060200n);throw new Error('private-secret');};
    await assert.rejects(f.make().check(),/WRITER_FENCED/);assert.equal(f.journal.workers().length,0);
  }finally{f.close();}
});

test('Monad watcher commits before callbacks, remains record-only after halt and drains on abort',async()=>{
  const f=setup(),stop=new AbortController();try{
    const monitor=f.make();f.set(1001n,11n,true);let calls=0;
    await watchMonadLifecycle(monitor,1000,stop.signal,view=>{
      calls++;assert.equal(view.mode,'RECORD_ONLY');assert.equal(f.journal.latest(monitor.namespace)!.payload.mode,'RECORD_ONLY');
      stop.abort();
    });assert.equal(calls,1);assert.equal(f.journal.verify(),true);
    const before=f.calls();await watchMonadLifecycle(monitor,1000,stop.signal,()=>assert.fail());assert.equal(f.calls(),before);
  }finally{f.close();}
});

test('Monad watcher stops on a persisted deadline/quarantine and rejects unsafe intervals',async()=>{
  for(const mode of ['STOPPED','QUARANTINED']){
    const f=setup();try{
      if(mode==='STOPPED')f.set(100031n,11n);else f.setChain(143);
      const monitor=f.make();let calls=0;await watchMonadLifecycle(monitor,1000,new AbortController().signal,view=>{calls++;assert.equal(view.mode,mode);});
      assert.equal(calls,1);await assert.rejects(watchMonadLifecycle(monitor,1,new AbortController().signal,()=>{}),/MONAD_BAD_MONITOR_INTERVAL/);
    }finally{f.close();}
  }
});

test('Monad watcher polls again after an outage and authentic fresh state recovers without resetting its journal',async()=>{
  const f=setup(),stop=new AbortController();try{
    f.fail(true);const monitor=f.make(),modes:string[]=[];
    await watchMonadLifecycle(monitor,1000,stop.signal,view=>{
      modes.push(view.mode);
      if(modes.length===1){f.fail(false);f.set(1001n,11n,true);}else stop.abort();
    });
    assert.deepEqual(modes,['DEGRADED','RECORD_ONLY']);assert.equal(f.journal.read(monitor.namespace).length,2);
  }finally{f.close();}
});

test('Monad graceful lease release allows a new owner immediately and cannot erase another owner fence',async()=>{
  const f=setup();try{
    const first=f.make();await first.check();assert.equal(first.releaseLease(),true);assert.equal(first.releaseLease(),false);
    const second=new MonadTestnetLifecycleMonitor(f.cfg,f.journal,'new-owner',f.reader,30000n,f.clock);
    assert.equal((await second.check()).mode,'COLLECTING');
    assert.equal(f.journal.release(first.namespace,'fixture-owner',1n),false);
    await assert.rejects(first.check(),/WRITER_BUSY/);assert.equal(second.releaseLease(),true);
    assert.equal((await first.check()).mode,'COLLECTING');assert.equal(f.journal.verify(),true);
  }finally{f.close();}
});

test('Monad lease cannot be released while an engine check is in flight',async()=>{
  const f=setup();try{
    let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve;}),chain=f.rpc.chainId;
    f.rpc.chainId=async()=>{await gate;return chain();};const monitor=f.make(),pending=monitor.check();
    assert.throws(()=>monitor.releaseLease(),/LIFECYCLE_CHECK_RUNNING/);unblock();await pending;
    assert.equal(monitor.releaseLease(),true);
  }finally{f.close();}
});

test('Journal graceful release keeps increasing fences and stale released writers cannot append',()=>{
  const journal=new Journal(':memory:');try{
    const first=journal.acquire('worker','owner',1n,1000n);assert.equal(journal.release('worker','owner',first),true);
    const second=journal.acquire('worker','owner',2n,1000n);assert.equal(second,first+1n);
    assert.equal(journal.release('worker','owner',first),false);
    assert.throws(()=>journal.append('worker','owner',first,3n,{}),/WRITER_FENCED/);
    journal.append('worker','owner',second,3n,{valid:true});assert.equal(journal.verify(),true);
  }finally{journal.close();}
});
