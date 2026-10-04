import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AlertTransitions, operationsHealth, parseOperationsSettings, watchOperations } from '../src/operations.js';
import { parseDeploymentProfile, prepareDeployment, writeSupervision } from '../src/deployment.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { workerNamespace } from '../src/worker.js';
import { base, config } from './publication-fixture.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const defaults={schemaVersion:'1',intervalMs:1000,maxCaptureSilenceMs:'30000',minimumFreeBytes:'0',maximumPendingDeliveries:1,
  maxReceiptSilenceMs:'120000',minimumBudgetRemainingWei:'0',maxBackupAgeMs:'86400000',backup:null};
function fixture(capture=true){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-operations-')),state=join(dir,'state'),configs=join(dir,'configs.json'),profileFile=join(dir,'profile.json'),now=BigInt(Date.now());
  writeFileSync(configs,json([base]));const profile=parseDeploymentProfile({schemaVersion:'1',mode:'READ_ONLY_COLLECTION',stateDirectory:state,
    inputs:{configs:{path:configs,sha256:sha(readFileSync(configs))}},restart:{delayMs:1000,maxRestarts:2,stopTimeoutMs:2000},streamHints:false,testnet:null});
  writeFileSync(profileFile,json(profile));prepareDeployment(profile);
  const ns=workerNamespace(base),source=join(state,'source.sqlite');
  if(capture){const journal=new Journal(source),fence=journal.acquire(ns,'fixture',now,10000n);
    journal.append(ns,'fixture',fence,now,{worker:ns,category:base.category,atMs:now,configDigest:sha(json(base)),
      inspection:{status:'COLLECTING',reason:null,time:{sourceMs:now,observedAt:now/1000n}}});journal.release(ns,'fixture',fence);journal.close();}
  writeSupervision(profile,{phase:'RUNNING',restarts:0,reason:null});
  return {dir,profile,profileFile,source,now,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const codes=(report:ReturnType<typeof operationsHealth>)=>report.alerts.map(a=>a.code);

test('operator thresholds and backup pins are explicit, bounded and parsed as integer units',()=>{
  assert.equal(parseOperationsSettings(defaults).minimumFreeBytes,0n);
  for(const change of [{intervalMs:0},{maxCaptureSilenceMs:'0'},{maximumPendingDeliveries:-1},{minimumFreeBytes:'1.5'},
    {backup:{directory:'relative',manifestSha256:'x'}}])assert.throws(()=>parseOperationsSettings({...defaults,...change}));
});
test('freshness is rechecked at query time; source unavailable is never reported as a zero price',()=>{
  const f=fixture();try{
    const settings=parseOperationsSettings(defaults),fresh=operationsHealth(f.profileFile,settings,f.now);
    assert.equal(fresh.collectionHealthy,true);assert.equal(fresh.healthy,false);assert.ok(codes(fresh).includes('OPS_BACKUP_NOT_CONFIGURED'));
    const stale=operationsHealth(f.profileFile,settings,f.now+31000n);
    assert.equal(stale.collectionHealthy,false);assert.equal(stale.workers[0]!.currentStatus,'DEGRADED');
    assert.ok(codes(stale).includes('OPS_SOURCE_UNAVAILABLE'));assert.ok(!Object.hasOwn(stale.workers[0]!,'priceWad'));
  }finally{f.close();}
});
test('a missing first capture is visible while a stopped or parked service stays unhealthy',()=>{
  const f=fixture(false);try{
    writeSupervision(f.profile,{phase:'STOPPED',restarts:0,reason:null});const r=operationsHealth(f.profileFile,parseOperationsSettings(defaults),f.now);
    assert.equal(r.collectionHealthy,false);assert.equal(r.workers[0]!.currentStatus,'UNAVAILABLE');
    assert.equal(r.workers[0]!.lastCaptureAtMs,null);assert.ok(codes(r).includes('OPS_SERVICE_STOPPED'));assert.ok(codes(r).includes('OPS_NO_SOURCE_CAPTURE'));
  }finally{f.close();}
});
test('capture silence has an exact boundary independent of source freshness',()=>{
  const f=fixture();try{
    const settings=parseOperationsSettings({...defaults,maxCaptureSilenceMs:'100'});
    assert.ok(!codes(operationsHealth(f.profileFile,settings,f.now+100n)).includes('OPS_SOURCE_SILENT'));
    const r=operationsHealth(f.profileFile,settings,f.now+101n);assert.ok(codes(r).includes('OPS_SOURCE_SILENT'));assert.equal(r.collectionHealthy,false);
  }finally{f.close();}
});
test('operator stop, low disk and source corruption raise fixed alerts without clearing state',()=>{
  const f=fixture();try{
    writeSupervision(f.profile,{phase:'OPERATOR_STOP',restarts:2,reason:'SERVICE_RESTART_LIMIT'});
    const settings=parseOperationsSettings({...defaults,minimumFreeBytes:((1n<<64n)-1n).toString()}),r=operationsHealth(f.profileFile,settings,f.now);
    assert.ok(codes(r).includes('OPS_OPERATOR_STOP'));assert.ok(codes(r).includes('OPS_DISK_LOW'));assert.equal(r.collectionHealthy,false);
    const db=new DatabaseSync(f.source);db.exec("UPDATE captures SET sha256='bad'");db.close();
    const corrupt=operationsHealth(f.profileFile,settings,f.now);assert.ok(codes(corrupt).includes('SERVICE_ARCHIVE_INTEGRITY'));assert.equal(corrupt.healthy,false);
  }finally{f.close();}
});
test('log alerts open once per condition/worker and clear when that condition resolves',()=>{
  const transitions=new AlertTransitions(),a={code:'OPS_SOURCE_SILENT',worker:'a'},b={...a,worker:'b'};
  assert.equal(transitions.update([a],1n)[0]!.event,'ALERT_OPEN');assert.equal(transitions.update([a],2n).length,0);
  const events=transitions.update([b],3n);assert.deepEqual(events.map(e=>e.event),['ALERT_OPEN','ALERT_CLEARED']);
  assert.equal(transitions.update([],4n)[0]!.worker,'b');
});
test('watch emits read-only health/alerts and shutdown wakes a long monitoring interval',async()=>{
  const f=fixture(),stop=new AbortController(),events:Record<string,unknown>[]=[];try{
    const begun=performance.now();await watchOperations(f.profileFile,parseOperationsSettings({...defaults,intervalMs:60000}),stop.signal,event=>{
      events.push(event as Record<string,unknown>);if(events.length===1)stop.abort();});
    assert.ok(performance.now()-begun<1000);assert.equal(events[0]!.event,'OPERATIONS_HEALTH');assert.equal(events[0]!.operationalOutput,false);
    assert.ok(events.some(e=>e.event==='ALERT_OPEN'));
  }finally{f.close();}
});
test('backup health validates the pinned bundle, age and changed archive without modifying active data',()=>{
  const f=fixture();try{
    writeSupervision(f.profile,{phase:'STOPPED',restarts:0,reason:null});const bundle=join(f.dir,'backup');
    const result=spawnSync('python3',[fileURLToPath(new URL('../../scripts/backup-journals.py',import.meta.url)),'backup',f.profileFile,bundle],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);const pin=JSON.parse(result.stdout).manifestSha256 as string;
    const settings=parseOperationsSettings({...defaults,backup:{directory:bundle,manifestSha256:pin}}),before=sha(readFileSync(f.source));
    const checked=operationsHealth(f.profileFile,settings,BigInt(Date.now()));assert.equal(checked.backup!.verified,true);
    assert.ok(!codes(checked).includes('OPS_BACKUP_VERIFICATION_FAILED'));
    assert.ok(codes(operationsHealth(f.profileFile,settings,BigInt(Date.now())+86400001n)).includes('OPS_BACKUP_STALE'));
    writeFileSync(join(bundle,'journals/source.sqlite'),'corrupted');const corrupt=operationsHealth(f.profileFile,settings,BigInt(Date.now()));
    assert.ok(codes(corrupt).includes('OPS_BACKUP_VERIFICATION_FAILED'));assert.equal(sha(readFileSync(f.source)),before);
    console.log('OPERATIONS_CASE '+JSON.stringify({scenario:'pinned-backup-health',corruptionDetected:true,activeJournalUnchanged:true,keysUnlocked:0,transactionsSent:0}));
  }finally{f.close();}
});

test('Monad status exposes exact reservation limits and block-labeled cached receipts without RPC or signing',()=>{
  const f=fixture(false);try{
    const state=join(f.dir,'testnet-state'),cfg={...config,destination:{...config.destination!,chainId:'10143'}},inputs:Record<string,{path:string;sha256:string}>={};
    for(const name of ['config','rules','abi','policy']){const file=join(f.dir,name+'.json');writeFileSync(file,json(name==='config'?cfg:{}));inputs[name]={path:file,sha256:sha(readFileSync(file))};}
    for(const name of ['packets','signer','transactions'])writeFileSync(join(f.profile.stateDirectory,name+'.sqlite'),'public fixture placeholder');
    const db=new DatabaseSync(join(f.profile.stateDirectory,'relay.sqlite'));
    const relay={chainId:'10143',maxTransactions:2,totalMaxCostWei:'50000',relayPolicy:{maxCostWei:'25000'}};
    db.exec('CREATE TABLE relay_control(id INTEGER PRIMARY KEY,profile TEXT,reason TEXT); CREATE TABLE deliveries(key TEXT PRIMARY KEY,body TEXT,sha256 TEXT);');
    db.prepare('INSERT INTO relay_control VALUES(1,?,NULL)').run(json(relay));
    const finalized={state:'FINALIZED',request:{gas:'21000',maxFeePerGas:'1'},accepted:{acceptedAt:(f.now/1000n).toString(),blockNumber:'42',blockHash:'0x'+'ab'.repeat(32),depthValid:false}};
    const pending={state:'UNKNOWN',request:{gas:'22000',maxFeePerGas:'1'},accepted:null};
    for(const [i,d] of [finalized,pending].entries()){const body=json(d);db.prepare('INSERT INTO deliveries VALUES(?,?,?)').run(String(i),body,sha(body));}db.close();
    const profile=parseDeploymentProfile({schemaVersion:'1',mode:'MONAD_TESTNET',stateDirectory:state,inputs,restart:f.profile.restart,streamHints:false,
      testnet:{rpcEnv:'NO_REAL_RPC',keysDirectory:join(f.dir,'unopened-keys'),journalDirectory:f.profile.stateDirectory,
        notAfterMs:(f.now+60000n).toString(),durationSeconds:60,stopAfterFinalized:2}});
    prepareDeployment(profile);writeSupervision(profile,{phase:'RUNNING',restarts:0,reason:null});
    const file=join(f.dir,'testnet-profile.json');writeFileSync(file,json(profile));
    const r=operationsHealth(file,parseOperationsSettings({...defaults,maximumPendingDeliveries:0}),f.now);
    assert.ok(r.publication,json(r.alerts));assert.equal(r.publication.reservedWei,43000n);assert.equal(r.publication.remainingReservationWei,7000n);
    assert.equal(r.publication.remainingReservations,0);assert.ok(codes(r).includes('OPS_BUDGET_EXHAUSTED'));assert.ok(codes(r).includes('OPS_PUBLICATION_BACKLOG'));
    assert.deepEqual(r.publication.lastFinalizedReceipt,finalized.accepted);assert.equal(r.publication.chainQueried,false);
    assert.equal(r.publication.indexTwap300,null);assert.equal(r.publication.walletBalanceWei,null);
    assert.equal(operationsHealth(file,parseOperationsSettings(defaults),f.now+121000n).healthy,false);
    console.log('OPERATIONS_CASE '+JSON.stringify({scenario:'cached-monad-publication-status',blockNumber:'42',reservedWei:'43000',remainingWei:'7000',chainQueried:false,keysUnlocked:0,transactionsSent:0}));
  }finally{f.close();}
});

test('Render wrapper monitors missing archives while parked and TERM wakes its monitoring timer',async()=>{
  const f=fixture(false),settingsFile=join(f.dir,'operations.json');
  writeFileSync(settingsFile,json({...defaults,intervalMs:60000}));rmSync(f.source);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/render-start.js',import.meta.url))],
    {env:{...process.env,PRICEFEED_SERVICE_PROFILE:f.profileFile,PRICEFEED_OPERATIONS_CONFIG:settingsFile},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=String(chunk);});child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  const completion=new Promise<number|null>(resolve=>child.once('close',resolve));
  try{
    const deadline=performance.now()+10000;
    while(!stdout.includes('SERVICE_PARKED')){assert.ok(performance.now()<deadline,stdout+stderr);await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(stdout.includes('OPERATIONS_HEALTH'));assert.ok(stdout.includes('ALERT_OPEN'));assert.ok(!stdout.includes('WORKER_STARTED'));
    const begun=performance.now();child.kill('SIGTERM');assert.equal(await completion,0);assert.ok(performance.now()-begun<2000);
    assert.throws(()=>readFileSync(f.source));
    console.log('OPERATIONS_CASE '+JSON.stringify({scenario:'render-monitor-while-parked',missingArchiveRecreated:false,shutdownWokeTimer:true,transactionsSent:0}));
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await completion;f.close();}
});
