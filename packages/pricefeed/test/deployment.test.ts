import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { checkDeployment, deploymentDeadline, parseDeploymentProfile, prepareDeployment, readSupervision, writeSupervision,
  type DeploymentProfile } from '../src/deployment.js';
import { restartable } from '../src/supervisor.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { base, config, metadata, event, body } from './publication-fixture.js';

const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const supervisor=fileURLToPath(new URL('../scripts/supervise.js',import.meta.url));
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type Running={child:ReturnType<typeof spawn>;records:Record<string,unknown>[];completion:Promise<{code:number|null;signal:string|null}>;
  until:(check:()=>boolean,timeout?:number)=>Promise<void>;output:()=>{stdout:string;stderr:string}};

function fixture(sourceDelayMs=0){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-deployment-')),state=join(dir,'state'),configsFile=join(dir,'configs.json'),profileFile=join(dir,'profile.json');
  const cfg={...base,poll:{...base.poll,intervalMs:100,timeoutMs:200,maxRetries:0,retryDelayMs:0}};
  writeFileSync(configsFile,json([cfg]));
  const profile=parseDeploymentProfile({schemaVersion:'1',mode:'READ_ONLY_COLLECTION',stateDirectory:state,
    inputs:{configs:{path:configsFile,sha256:sha(readFileSync(configsFile))}},restart:{delayMs:1000,maxRestarts:2,stopTimeoutMs:2000},streamHints:false,testnet:null});
  writeFileSync(profileFile,json(profile));const preload=join(dir,'source.mjs');
  writeFileSync(preload,`
    const event=${JSON.stringify(event)},metadata=${JSON.stringify(metadata)},book=${body};
    globalThis.fetch=async url=>{
      if(${sourceDelayMs}){
        console.log(JSON.stringify({event:'FIXTURE_REQUEST'}));
        await new Promise(resolve=>setTimeout(resolve,${sourceDelayMs}));
      }
      const value=url.includes('/events/')?event:url.includes('/markets/')?metadata:{...book,timestamp:String(Date.now())};
      return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    };
  `);
  const env:NodeJS.ProcessEnv={...process.env,NODE_OPTIONS:'--import='+preload};delete env.NODE_TEST_CONTEXT;
  const children:Running[]=[];
  function launch(args=['run',profileFile],script=supervisor,customEnv:NodeJS.ProcessEnv=env):Running{
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',script,...args],{env:customEnv,stdio:['ignore','pipe','pipe']});
    const records:Record<string,unknown>[]=[];let stdout='',stderr='',buffer='';
    child.stdout!.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();buffer+=chunk.toString();
      while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{records.push(JSON.parse(line));}catch{/* No public body is interpreted as a command. */}}});
    child.stderr!.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
    const completion=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    const until=async(check:()=>boolean,timeout=20000)=>{const end=Date.now()+timeout;
      while(!check()){if(Date.now()>end)throw new Error('DEPLOYMENT_FIXTURE_TIMEOUT '+child.exitCode+' '+child.signalCode+' '+stdout+' '+stderr);await pause(10);}};
    const value={child,records,completion,until,output:()=>({stdout,stderr})};children.push(value);return value;
  }
  const source=()=>new DatabaseSync(join(state,'source.sqlite'),{readOnly:true});
  const rows=()=>{const db=source();try{return Number(db.prepare('SELECT count(*) n FROM captures').get()!.n);}finally{db.close();}};
  const stop=async(s:ReturnType<typeof launch>)=>{if(s.child.exitCode===null&&s.child.signalCode===null)s.child.kill('SIGTERM');await s.completion;};
  const close=async()=>{
    for(const s of children){
      if(s.child.exitCode===null&&s.child.signalCode===null)s.child.kill('SIGTERM');
      for(const e of s.records)if(e.event==='LOCK_HOLDER_STARTED'&&typeof e.pid==='number'){
        try{process.kill(-e.pid,'SIGTERM');}catch{/* Fixture group already ended. */}}
    }
    await Promise.all(children.map(c=>c.completion));rmSync(dir,{recursive:true,force:true});
  };
  return {dir,state,cfg,configsFile,profileFile,profile,env,launch,source,rows,stop,close};
}

test('explicit preparation pins inputs and refuses existing/missing/corrupt state without rebuilding it',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);assert.equal(checkDeployment(f.profile).length,1);
    assert.throws(()=>prepareDeployment(f.profile),/ALREADY_PREPARED/);
    const original=readFileSync(f.configsFile);writeFileSync(f.configsFile,original+' ');
    assert.throws(()=>checkDeployment(f.profile),/INPUT_PIN_MISMATCH/);writeFileSync(f.configsFile,original);
    const source=join(f.state,'source.sqlite'),bytes=readFileSync(source);rmSync(source);
    assert.throws(()=>checkDeployment(f.profile),/JOURNAL_MISSING/);assert.throws(()=>prepareDeployment(f.profile),/ALREADY_PREPARED/);
    writeFileSync(source,bytes);
    writeFileSync(join(f.state,'supervision.json'),'{}');assert.throws(()=>readSupervision(f.profile),/INTEGRITY/);
  }finally{await f.close();}
});

test('real supervised processes release leases on SIGTERM and a new process retains all earlier captures',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const first=f.launch();await first.until(()=>first.records.some(e=>e.event==='SOURCE_CAPTURE'));
    await f.stop(first);const before=f.rows();assert.ok(before>0);assert.equal(readSupervision(f.profile).phase,'STOPPED');
    const db=f.source();try{assert.equal(db.prepare('SELECT until_ms FROM writers').get()!.until_ms,'0');}finally{db.close();}
    const second=f.launch();await second.until(()=>second.records.some(e=>e.event==='SOURCE_CAPTURE'));await f.stop(second);
    assert.ok(f.rows()>before);const after=f.source();try{assert.equal(after.prepare('SELECT fence FROM writers').get()!.fence,2);}finally{after.close();}
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'graceful-new-process-restart',capturesBefore:before,capturesAfter:f.rows(),realSqlite:true,source:'scripted',transactionsSent:0}));
  }finally{await f.close();}
});

test('a second supervisor cannot acquire the OS lock or change the writer fence',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const first=f.launch();await first.until(()=>first.records.some(e=>e.event==='SOURCE_CAPTURE'));
    const second=f.launch();assert.equal((await second.completion).code,78);assert.ok(!second.records.some(e=>e.event==='WORKER_STARTED'));
    const db=f.source();try{assert.equal(db.prepare('SELECT fence FROM writers').get()!.fence,1);}finally{db.close();}
    await f.stop(first);console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'duplicate-supervisor-rejected',exitCode:78,writerFence:1,transactionsSent:0}));
  }finally{await f.close();}
});

test('repeated TERM during an in-flight source request drains and releases the worker lease',async()=>{
  const f=fixture(100);try{
    prepareDeployment(f.profile);const run=f.launch();
    await run.until(()=>run.records.some(e=>e.event==='FIXTURE_REQUEST'));
    const pid=run.records.find(e=>e.event==='WORKER_STARTED')!.pid as number;
    process.kill(pid,'SIGTERM');await pause(10);process.kill(pid,'SIGTERM');
    assert.equal((await run.completion).code,0);
    const exited=run.records.find(e=>e.event==='WORKER_EXIT')!;
    assert.equal(exited.code,0);assert.equal(exited.signal,null);
    const db=f.source();try{assert.equal(db.prepare('SELECT until_ms FROM writers').get()!.until_ms,'0');}finally{db.close();}
    assert.equal(readSupervision(f.profile).phase,'STOPPED');
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'repeated-term-during-drain',workerExitCode:0,leaseReleased:true,transactionsSent:0}));
  }finally{await f.close();}
});

test('an OS-killed worker restarts after its real source lease expires with persisted captures and bounded retries',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const run=f.launch();await run.until(()=>run.records.some(e=>e.event==='SOURCE_CAPTURE'));
    const pid=run.records.find(e=>e.event==='WORKER_STARTED')!.pid as number,before=f.rows();process.kill(pid,'SIGKILL');
    await run.until(()=>run.records.filter(e=>e.event==='WORKER_STARTED').length===2,25000);
    await run.until(()=>f.rows()>before,10000);await f.stop(run);
    assert.ok(run.records.some(e=>e.event==='LEASE_WAIT'));assert.equal(readSupervision(f.profile).restarts,1);
    assert.equal(readSupervision(f.profile).phase,'STOPPED');
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'sigkill-worker-lease-recovery',capturesBefore:before,capturesAfter:f.rows(),restarts:1,leaseForced:false,transactionsSent:0}));
  }finally{await f.close();}
});

test('corrupt restored captures and persisted operator stops launch no worker or source request',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const first=f.launch();await first.until(()=>first.records.some(e=>e.event==='SOURCE_CAPTURE'));await f.stop(first);const before=f.rows();
    const db=new DatabaseSync(join(f.state,'source.sqlite'));db.prepare("UPDATE captures SET sha256='bad' WHERE id=1").run();db.close();
    const corrupt=f.launch();assert.equal((await corrupt.completion).code,78);assert.equal(f.rows(),before);
    assert.ok(!corrupt.records.some(e=>e.event==='WORKER_STARTED'));assert.match(corrupt.output().stderr,/SERVICE_ARCHIVE_INTEGRITY/);
    const clean=new DatabaseSync(join(f.state,'source.sqlite'));const row=clean.prepare('SELECT payload FROM captures WHERE id=1').get()!;
    clean.prepare('UPDATE captures SET sha256=? WHERE id=1').run(sha(String(row.payload)));clean.close();
    writeSupervision(f.profile,{phase:'OPERATOR_STOP',restarts:1,reason:'SERVICE_RESTART_LIMIT'});
    const stopped=f.launch();assert.equal((await stopped.completion).code,78);assert.ok(!stopped.records.some(e=>e.event==='WORKER_STARTED'));
    assert.equal(readSupervision(f.profile).phase,'OPERATOR_STOP');
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'corruption-and-operator-stop',workerRelaunched:false,transactionsSent:0}));
  }finally{await f.close();}
});

test('persisted unfinished-run restart allowance cannot be reset by host relaunch',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);writeSupervision(f.profile,{phase:'RUNNING',restarts:2,reason:null});
    const s=f.launch();assert.equal((await s.completion).code,78);assert.ok(!s.records.some(e=>e.event==='WORKER_STARTED'));
    assert.deepEqual(readSupervision(f.profile),{phase:'OPERATOR_STOP',restarts:3,reason:'SERVICE_RESTART_LIMIT'});
    const again=f.launch();assert.equal((await again.completion).code,78);assert.ok(!again.records.some(e=>e.event==='WORKER_STARTED'));
  }finally{await f.close();}
});

test('an orphaned worker retains the OS lock after its supervisor is killed, then a new supervisor reconciles state',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const first=f.launch();await first.until(()=>first.records.some(e=>e.event==='SOURCE_CAPTURE'));
    const parent=first.records.find(e=>e.event==='SUPERVISOR_READY')!.pid as number;
    const worker=first.records.find(e=>e.event==='WORKER_STARTED')!.pid as number;
    process.kill(parent,'SIGKILL');await pause(150);
    const duplicate=f.launch();assert.equal((await duplicate.completion).code,78);
    assert.ok(!duplicate.records.some(e=>e.event==='WORKER_STARTED'));
    process.kill(worker,'SIGTERM');await first.completion;const before=f.rows();
    assert.equal(readSupervision(f.profile).phase,'RUNNING');
    const resumed=f.launch();await resumed.until(()=>resumed.records.some(e=>e.event==='SOURCE_CAPTURE'));await f.stop(resumed);
    assert.ok(f.rows()>before);assert.equal(readSupervision(f.profile).restarts,1);
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'sigkill-supervisor-orphan-lock',duplicateExitCode:78,orphanHeldLock:true,writerResumed:true,transactionsSent:0}));
  }finally{await f.close();}
});

test('Render operator stop stays parked instead of recreating missing journals or looping worker launches',async()=>{
  const f=fixture();try{
    const wrapper=fileURLToPath(new URL('../scripts/render-start.js',import.meta.url));
    const run=f.launch([],wrapper,{...f.env,PRICEFEED_SERVICE_PROFILE:f.profileFile});
    await run.until(()=>run.records.some(e=>e.event==='SERVICE_PARKED'));await pause(1100);
    assert.equal(run.records.filter(e=>e.event==='SERVICE_PARKED').length,1);
    assert.ok(!run.records.some(e=>e.event==='WORKER_STARTED'));assert.equal(run.child.exitCode,null);
    assert.throws(()=>readFileSync(join(f.state,'source.sqlite')));await f.stop(run);
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'render-parked-no-bootstrap',workerRelaunched:false,missingArchiveRecreated:false,transactionsSent:0}));
  }finally{await f.close();}
});

test('finite Monad campaign deadline is pinned at preparation and cannot renew on restart',async()=>{
  const f=fixture();try{
    const journals=join(f.dir,'journals');mkdirSync(journals,{mode:0o700});new Journal(join(journals,'source.sqlite')).close();
    for(const name of ['packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite'])writeFileSync(join(journals,name),'');
    const cfg=join(f.dir,'testnet.json');writeFileSync(cfg,json({...config,destination:{...config.destination!,chainId:'10143'}}));
    const inputs=Object.fromEntries(['config','rules','abi','policy'].map(name=>[name,{path:cfg,sha256:sha(readFileSync(cfg))}]));
    const p=parseDeploymentProfile({...f.profile,mode:'MONAD_TESTNET',inputs,
      testnet:{rpcEnv:'TEST_RPC',keysDirectory:join(f.dir,'keys-never-opened'),journalDirectory:journals,
        notAfterMs:String(Date.now()+60000),durationSeconds:30,stopAfterFinalized:1}});
    prepareDeployment(p);const deadline=deploymentDeadline(p)!;assert.ok(deadline<=BigInt(Date.now())+30000n);
    await pause(5);checkDeployment(p);assert.equal(deploymentDeadline(p),deadline);
    const changed={...p,testnet:{...p.testnet!,notAfterMs:String(Date.now()+120000)}};
    assert.throws(()=>checkDeployment(changed),/MARKER_MISMATCH/);
    console.log('DEPLOYMENT_CASE '+JSON.stringify({scenario:'testnet-deadline-immutable',keysOpened:false,transactionsSent:0}));
  }finally{await f.close();}
});

test('restart classification never relaunches normal/finite/key/budget/quarantine/integrity stops',()=>{
  for(const reason of ['KEY_UNLOCK_FAILED','TESTNET_RELAY_BUDGET_EXHAUSTED','RELAY_QUARANTINED','SIGNED_SOURCE_HISTORY_MISMATCH','EVIDENCE_INTEGRITY_FAILURE'])
    assert.equal(restartable(1,null,reason),false);
  for(const code of [0,2,78])assert.equal(restartable(code,null,'WRITER_BUSY'),false);
  assert.equal(restartable(null,'SIGTERM',''),false);assert.equal(restartable(null,'SIGKILL',''),true);
  assert.equal(restartable(1,null,'WRITER_BUSY'),true);
  const profile:Partial<DeploymentProfile>={};assert.throws(()=>parseDeploymentProfile(profile));
  const secret='https://fixture.invalid/secret';assert.equal(restartable(1,null,secret),false);
});

test('existing serve CLI hands its worker lease to an immediate new process after SIGTERM',async()=>{
  const f=fixture();try{
    prepareDeployment(f.profile);const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
    const args=['serve','--configs',f.configsFile,'--db',join(f.state,'source.sqlite')];
    const first=f.launch(args,cli);await first.until(()=>f.rows()>0);await f.stop(first);
    const before=f.rows(),db=f.source();try{assert.equal(db.prepare('SELECT until_ms FROM writers').get()!.until_ms,'0');}finally{db.close();}
    const second=f.launch(args,cli);await second.until(()=>f.rows()>before);await f.stop(second);
    assert.equal((await second.completion).code,0);assert.ok(!second.output().stderr.includes('WRITER_BUSY'));
  }finally{await f.close();}
});
