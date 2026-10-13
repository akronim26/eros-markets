import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { workerNamespace } from '../src/worker.js';
import { observationDigest } from '../src/wire.js';
import { keccak256 } from 'viem';
import { parseEngineReadAbi } from '../src/monad-preflight.js';
import { config, reviewed, invalidConfig, invalidReviewed, metadata, event, body, candidate } from './publication-fixture.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-cli-')),db=join(dir,'captures.sqlite');
  const namespace=workerNamespace({...config,destination:null});
  const capture=<T>(data:T,at:string)=>({body:JSON.stringify(data),data:structuredClone(data),receivedAtMs:at,url:'https://fixture.invalid',attempts:1,latencyMs:0});
  const payload={worker:config.key,category:config.category,atMs:'1000100',configDigest:'fixture',
    inspection:{status:'COLLECTING',reason:null as string|null},event:capture(event,'1000000'),metadata:capture(metadata,'1000000'),
    book:capture(JSON.parse(body),'1000050')};
  const journal=new Journal(db),f=journal.acquire(namespace,'fixture',1000000n,10000n);
  journal.append(namespace,'fixture',f,1000100n,payload);journal.close();
  const cfg=join(dir,'config.json'),rules=join(dir,'rules.json');
  writeFileSync(cfg,json(config));writeFileSync(rules,json(reviewed));
  const args=['build-observation','--config',cfg,'--rules',rules,'--db',db,'--capture-id','1','--sequence','7','--published-at-ms','1000100'];
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=(argv=args)=>spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),...argv],{cwd:dir,encoding:'utf8',env,timeout:10000});
  const replace=(fn:(p:typeof payload)=>void,rehash=true)=>{
    fn(payload);const value=json(payload),database=new DatabaseSync(db);
    database.prepare('UPDATE captures SET payload=?,sha256=? WHERE id=1').run(value,rehash?createHash('sha256').update(value).digest('hex'):'bad');database.close();
  };
  return {dir,db,cfg,rules,args,run,replace,payload,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('discovery CLI rejects unsupported categories, pagination limits and activation options without network or journals',()=>{
  const f=fixture();try{
    const base=['discover-markets','--category','sports','--tag-slug','sports','--page-size','2','--max-pages','2'];
    for(const args of [base.map(v=>v==='sports'?'invalid/category':v),base.map(v=>v==='2'?'0':v),[...base,'--enabled','true'],
      [...base,'--keys-dir',f.dir],[...base,'--rpc-env','SECRET_RPC']]){
      const before=readFileSync(f.db),result=f.run(args);assert.equal(result.status,1,result.stderr);
      assert.match(result.stderr,/BAD_DISCOVERY_OPTIONS|UNSUPPORTED_OPTION/);assert.deepEqual(readFileSync(f.db),before);
    }
  }finally{f.close();}
});
test('stream CLI rejects ambiguous toggles before creating a database or using network',()=>{
  const f=fixture();try{
    const before=readdirSync(f.dir).sort();
    for(const command of ['serve','serve-monad-testnet']){
      const result=f.run([command,'--stream-hints','yes']);assert.equal(result.status,1);
      assert.equal(result.stderr.trim(),'BAD_STREAM_HINTS_OPTION');assert.equal(result.stdout,'');
    }
    assert.deepEqual(readdirSync(f.dir).sort(),before);
  }finally{f.close();}
});

test('offline CLI reconstructs an unsigned eleven-field packet without modifying the archive or allocating sequence',()=>{
  const f=fixture();try{
    const before=readFileSync(f.db);const result=f.run();assert.equal(result.status,0,result.stderr);
    const out=JSON.parse(result.stdout);assert.equal(out.mode,'DEVELOPMENT_OFFLINE_REPLAY');assert.equal(out.available,true);
    assert.equal(out.packet.observation.sequence,'7');assert.equal(out.packet.observation.priceWad,'600000000000000000');
    assert.equal(out.packet.observation.bidDepthLots,'6000');assert.equal(out.packet.observation.observedAt,'1000');
    assert.equal(out.packet.sourceMs,'1000000');assert.equal(Object.keys(out.packet.observation).length,11);
    const expected=candidate(7n);assert.equal(out.digest,observationDigest(expected.observation,expected.domain.chainId,expected.domain.engine));
    assert.equal(out.signaturesProduced,0);assert.equal(out.transactionsSent,0);assert.equal(out.sequenceAllocated,false);
    assert.equal(out.lifecycleVerified,false);assert.equal(out.listingVerified,false);assert.equal(out.operationalOutput,false);
    assert.deepEqual(readFileSync(f.db),before);
    const database=new DatabaseSync(f.db,{readOnly:true});try{
      assert.equal(database.prepare('SELECT count(*) AS n FROM captures').get()!.n,1);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),['captures','writers']);
    }finally{database.close();}
  }finally{f.close();}
});

test('offline CLI retains original wide-book impacts while explicitly selected invalid packet has zero prices',()=>{
  const f=fixture();try{
    writeFileSync(f.cfg,json(invalidConfig));writeFileSync(f.rules,json(invalidReviewed));
    f.replace(p=>{p.book.data.asks=[{price:'0.90',size:'6'}];p.book.body=JSON.stringify(p.book.data);p.inspection.status='INVALID_DEPTH';});
    const result=f.run();assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);
    assert.equal(out.inspection.status,'INVALID_DEPTH');assert.equal(out.inspection.summary.impactAskWad,'900000000000000000');
    for(const field of ['priceWad','impactBidWad','impactAskWad'])assert.equal(out.packet.observation[field],'0');
    assert.equal(out.packet.observation.askDepthLots,'6000');
    writeFileSync(f.cfg,json(config));writeFileSync(f.rules,json(reviewed));
    const unavailable=f.run();assert.equal(unavailable.status,2);assert.equal(JSON.parse(unavailable.stdout).packet,null);
  }finally{f.close();}
});

test('offline CLI does not refresh historical source time or bypass archived quarantine',()=>{
  const f=fixture();try{
    const stale=f.run(f.args.map(x=>x==='1000100'?'1040000':x));assert.equal(stale.status,2,stale.stderr);
    assert.match(JSON.parse(stale.stdout).reason,/STALE_OR_FUTURE/);assert.equal(JSON.parse(stale.stdout).packet,null);
    f.replace(p=>{p.inspection.status='QUARANTINED';p.inspection.reason='RESTORED_QUARANTINE';});
    const result=f.run();assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).reason,'ARCHIVED_CAPTURE_NOT_ELIGIBLE');
  }finally{f.close();}
});

test('offline CLI rejects inconsistent raw/data representations and corrupt archive checksums',()=>{
  const f=fixture();try{
    f.replace(p=>{p.metadata.data.description='different parsed representation';});
    const mismatch=f.run();assert.equal(mismatch.status,1);assert.match(mismatch.stderr,/CAPTURE_BODY_DATA_MISMATCH/);
    f.replace(()=>{},false);const corrupt=f.run();assert.equal(corrupt.status,1);assert.match(corrupt.stderr,/EVIDENCE_INTEGRITY_FAILURE/);
  }finally{f.close();}
});

test('offline CLI accepts capture persistence latency without changing the packet timestamps',()=>{
  const f=fixture();try{
    const database=new DatabaseSync(f.db);database.prepare("UPDATE captures SET at_ms='1000101' WHERE id=1").run();database.close();
    const args=[...f.args];args[args.indexOf('--published-at-ms')+1]='1000102';
    const result=f.run(args);assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);
    assert.equal(out.packet.observation.observedAt,'1000');assert.equal(out.evidence.atMs,'1000101');
  }finally{f.close();}
});

test('offline CLI rejects missing captures, invalid sequence, future receive time and nonlocal destination',()=>{
  const f=fixture();try{
    for(const sequence of ['0','-1','1.5','18446744073709551616']){
      const args=[...f.args];args[args.indexOf('--sequence')+1]=sequence;assert.equal(f.run(args).status,1);
    }
    const missing=[...f.args];missing[missing.indexOf('--capture-id')+1]='2';assert.match(f.run(missing).stderr,/CAPTURE_NOT_FOUND/);
    f.replace(p=>{p.book.receivedAtMs='1000200';});assert.equal(f.run().status,1);
    writeFileSync(f.cfg,json({...config,destination:{...config.destination!,chainId:'10143'}}));
    assert.match(f.run().stderr,/DEVELOPMENT_CHAIN_ONLY/);
  }finally{f.close();}
});

test('offline CLI checks worker identity, source-rule binding and raw event membership',()=>{
  const f=fixture();try{
    writeFileSync(f.rules,json({...reviewed,outcomeLabel:'No'}));assert.match(f.run().stderr,/RULES_CONFIG_MISMATCH/);
    writeFileSync(f.rules,json(reviewed));
    f.replace(p=>{p.metadata.data.description='changed provider rules';p.metadata.body=JSON.stringify(p.metadata.data);});
    assert.match(f.run().stderr,/SOURCE_RULES_CHANGED/);
    f.replace(p=>{p.metadata.data.description=metadata.description;p.metadata.body=JSON.stringify(p.metadata.data);p.event.data.id='123';p.event.body=JSON.stringify(p.event.data);});
    assert.match(f.run().stderr,/EVENT_IDENTITY_MISMATCH/);
    f.replace(p=>{p.worker='other-worker';});assert.match(f.run().stderr,/CAPTURE_WORKER_MISMATCH/);
  }finally{f.close();}
});

test('offline CLI recomputes fresh thin books and rejects unavailable closed, missing-time and future-time books',()=>{
  const f=fixture();try{
    writeFileSync(f.cfg,json(invalidConfig));writeFileSync(f.rules,json(invalidReviewed));
    // Archive summaries cannot substitute for calculation from the retained body.
    f.replace(p=>{p.book.data.bids=[{price:'0.59',size:'4'}];p.book.body=JSON.stringify(p.book.data);});
    const thin=f.run();assert.equal(thin.status,0,thin.stderr);const out=JSON.parse(thin.stdout);
    assert.equal(out.packet.observation.bidDepthLots,'4000');assert.equal(out.packet.observation.priceWad,'0');
    f.replace(p=>{p.metadata.data.closed=true;p.metadata.body=JSON.stringify(p.metadata.data);});
    const closed=f.run();assert.equal(closed.status,2);assert.equal(JSON.parse(closed.stdout).reason,'SOURCE_NOT_TRADEABLE');
    for(const timestamp of [undefined,'1000200']){
      f.replace(p=>{p.metadata.data.closed=false;p.metadata.body=JSON.stringify(p.metadata.data);p.book.data.timestamp=timestamp;p.book.body=JSON.stringify(p.book.data);});
      const absent=f.run();assert.equal(absent.status,2,absent.stderr);assert.equal(JSON.parse(absent.stdout).packet,null);
    }
  }finally{f.close();}
});

test('CLI errors redact malformed JSON, file paths and unknown option values; missing archive is never created',()=>{
  const f=fixture(),secret='super-secret-wallet-value';try{
    writeFileSync(f.rules,`{"secret":"${secret}" broken`);
    const malformed=f.run();assert.equal(malformed.status,1);assert.match(malformed.stderr,/INVALID_JSON_INPUT/);
    assert.ok(!malformed.stderr.includes(secret));assert.ok(!malformed.stderr.includes(f.dir));
    const unknown=f.run(['build-observation',`--${secret}`,secret]);assert.equal(unknown.status,1);assert.ok(!unknown.stderr.includes(secret));
    const duplicate=f.run([...f.args,'--sequence','8']);assert.match(duplicate.stderr,/BAD_OR_DUPLICATE_ARGUMENT/);
    writeFileSync(f.rules,json(reviewed));const missing=[...f.args],path=join(f.dir,`${secret}.sqlite`);
    missing[missing.indexOf('--db')+1]=path;const absent=f.run(missing);assert.equal(absent.status,1);assert.ok(!absent.stderr.includes(secret));
    assert.ok(!readdirSync(f.dir).includes(`${secret}.sqlite`));
    for(const command of ['sign-observation','send-observation','submit'])assert.equal(f.run([command]).status,1);
  }finally{f.close();}
});

test('Monad CLI requires an environment name and paired engine inputs without creating journals or leaking secrets',()=>{
  const f=fixture(),secret='private-rpc-secret';try{
    const env:NodeJS.ProcessEnv={...process.env,PRICEFEED_TEST_RPC:`http://rpc.invalid/${secret}`};delete env.NODE_TEST_CONTEXT;
    const run=(args:string[])=>spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),
      'preflight-monad',...args],{cwd:f.dir,encoding:'utf8',env,timeout:10000});
    const before=readdirSync(f.dir).sort();
    for(const [args,code] of [
      [['--rpc-env',`https://rpc.invalid/${secret}`],'MONAD_BAD_RPC_ENV_NAME'],
      [['--rpc-env','PRICEFEED_MISSING_ENV_TEST_ONLY'],'MONAD_RPC_ENV_MISSING'],
      [['--rpc-env','PRICEFEED_TEST_RPC','--config',f.cfg],'MONAD_CONFIG_AND_ABI_REQUIRED_TOGETHER'],
      [['--rpc-env','PRICEFEED_TEST_RPC','--abi',f.rules],'MONAD_CONFIG_AND_ABI_REQUIRED_TOGETHER'],
      [['--rpc-env','PRICEFEED_TEST_RPC'],'MONAD_HTTPS_RPC_REQUIRED'],
    ] as [string[],string][]){
      const r=run(args);assert.equal(r.status,1,r.stderr);assert.equal(r.stderr.trim(),code);
      assert.equal(r.stdout,'');assert.ok(!r.stderr.includes(secret));assert.ok(!r.stderr.includes(f.dir));
    }
    assert.deepEqual(readdirSync(f.dir).sort(),before);assert.ok(!readdirSync(f.dir).includes('var'));
  }finally{f.close();}
});

test('Monad watcher CLI rejects bad policies and missing engine dossier before creating an archive',()=>{
  const f=fixture(),secret='private-rpc-secret';try{
    const env:NodeJS.ProcessEnv={...process.env,PRICEFEED_TEST_RPC:`https://rpc.invalid/${secret}`};delete env.NODE_TEST_CONTEXT;
    const db=join(f.dir,'monad.sqlite'),before=readdirSync(f.dir).sort();
    const args=['--rpc-env','PRICEFEED_TEST_RPC','--config',f.cfg,'--abi',f.rules,'--db',db,
      '--interval-ms','1000','--max-checkpoint-age-ms','30000','--duration-seconds','1'];
    const run=(argv:string[])=>spawnSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),
      'watch-monad-lifecycle',...argv],{cwd:f.dir,encoding:'utf8',env,timeout:10000});
    for(const [key,value] of [['--interval-ms','999'],['--max-checkpoint-age-ms','30001'],['--duration-seconds','0']]){
      const bad=[...args];bad[bad.indexOf(key!)+1]=value!;const r=run(bad);
      assert.equal(r.status,1);assert.equal(r.stderr.trim(),'MONAD_BAD_MONITOR_POLICY');assert.ok(!r.stderr.includes(secret));
    }
    const missing=run(args.filter((_x,i)=>i!==args.indexOf('--config')&&i!==args.indexOf('--config')+1));
    assert.equal(missing.status,1);assert.match(missing.stderr,/REQUIRED_--config/);
    // The existing fixture is local chain 31337; monitoring must not adopt it on Monad.
    const wrong=run(args);assert.equal(wrong.status,1);assert.match(wrong.stderr,/MONAD_DISABLED_TESTNET_CONFIG_REQUIRED/);
    assert.deepEqual(readdirSync(f.dir).sort(),before);
  }finally{f.close();}
});

test('Monad watcher CLI archives fixture engine state, reports health and cleanly hands its lease to a restarted process',()=>{
  const f=fixture();try{
    const engineAbi=fileURLToPath(new URL('../../../../artifacts/risk/engine-abi.json',import.meta.url));
    const artifact=JSON.parse(readFileSync(engineAbi,'utf8')),now=BigInt(Math.floor(Date.now()/1000)),code='0x60006000';
    const cfg={...config,requiredFeedUntil:String(now+3600n),destination:{...config.destination!,chainId:'10143',
      engineCodeHash:keccak256(code),abiHash:parseEngineReadAbi(artifact).abiHash,listedAt:String(now-86400n),scheduledT:String(now+3600n)}};
    writeFileSync(f.cfg,json(cfg));const preload=join(f.dir,'fixture-rpc.mjs'),db=join(f.dir,'monad.sqlite');
    // Real CLI/HTTP encoding and real SQLite, with explicitly scripted RPC counterparts.
    writeFileSync(preload,`
      import { readFileSync } from 'node:fs';
      import { decodeFunctionData, encodeFunctionResult } from ${JSON.stringify(new URL('../../node_modules/viem/_esm/index.js',import.meta.url).href)};
      const cfg=JSON.parse(readFileSync(${JSON.stringify(f.cfg)},'utf8')),d=cfg.destination;
      const abi=JSON.parse(readFileSync(${JSON.stringify(engineAbi)},'utf8')).abi;
      const t=BigInt(Math.floor(Date.now()/1000)),hash='0x'+t.toString(16).padStart(64,'0'),address='0x'+'44'.repeat(20),number='0x'+t.toString(16);
      const listing={marketId:d.marketId,token:address,registry:address,resolutionAuthority:address,monitor:address,governance:address,
        scheduledT:BigInt(d.scheduledT),listedAt:BigInt(d.listedAt),sourceHash:hash,rulesHash:hash,
        invalidRule:{...d.invalidRule,captureGraceSecs:BigInt(d.invalidRule.captureGraceSecs),fallbackPriceWad:BigInt(d.invalidRule.fallbackPriceWad),voidSecs:BigInt(d.invalidRule.voidSecs)},
        template:0,deploymentCapX:0n,maxTraders:0,indexSourceId:d.sourceId,indexSigner:d.signerAddress,indexRulesHash:d.sourceRulesHash,
        depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad),bootstrapBandWad:0n,
        minOrderLots:1n,maxOrderLots:10n,maxLiqLotsPerBlock:100n,fundingEnabled:false};
      globalThis.fetch=async(_input,init)=>{
        const body=JSON.parse(init.body);const respond=req=>{let result;
        if(req.method==='eth_chainId')result='0x279f';
        else if(req.method==='eth_getBlockByNumber')result={number,hash,timestamp:'0x'+t.toString(16),transactions:[]};
        else if(req.method==='eth_getCode')result=${JSON.stringify(code)};
        else if(req.method==='eth_call'){
          if(req.params[1]!==number)throw new Error('WRONG_BLOCK');
          if(!req.params[0].to)return {jsonrpc:'2.0',id:req.id,result:d.engineCodeHash};
          const fn=decodeFunctionData({abi,data:req.params[0].data});
          result=encodeFunctionResult({abi,functionName:fn.functionName,result:fn.functionName==='listing'?listing:
            fn.functionName==='sourceState'?{signer:d.signerAddress,rulesHash:d.sourceRulesHash,lastSequence:1n,lastObservedAt:BigInt(d.listedAt)+86400n-1n,configured:true}:true});
        }else throw new Error('UNEXPECTED_METHOD');
        return {jsonrpc:'2.0',id:req.id,result};};
        return new Response(JSON.stringify(Array.isArray(body)?body.map(respond):respond(body)),{headers:{'Content-Type':'application/json'}});
      };
    `);
    const env:NodeJS.ProcessEnv={...process.env,PRICEFEED_TEST_RPC:'https://fixture.invalid/private-rpc-secret'};delete env.NODE_TEST_CONTEXT;
    const argv=['watch-monad-lifecycle','--rpc-env','PRICEFEED_TEST_RPC','--config',f.cfg,'--abi',engineAbi,'--db',db,
      '--interval-ms','1000','--max-checkpoint-age-ms','30000','--duration-seconds','1'];
    const run=()=>spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../src/cli.js',import.meta.url)),...argv],
      {cwd:f.dir,encoding:'utf8',env,timeout:15000});
    for(let i=0;i<2;i++){
      const r=run();assert.equal(r.status,0,r.stderr+'\n'+r.stdout);assert.ok(!r.stdout.includes('private-rpc-secret'));
      const outputs=r.stdout.trim().split(/\n(?=\{)/).map(row=>JSON.parse(row)),summary=outputs.at(-1);
      assert.equal(summary.completed,true);assert.equal(summary.lastMode,'RECORD_ONLY');assert.equal(summary.evidenceValid,true);
      assert.ok(summary.checks>=1);assert.equal(summary.transactionsSent,0);assert.equal(summary.signaturesProduced,0);
      assert.equal(outputs[0].lifecycle.checkpoint.chainId,'10143');
    }
    const database=new DatabaseSync(db,{readOnly:true});try{
      assert.equal(database.prepare('SELECT until_ms FROM writers').get()!.until_ms,'0');
      assert.equal(database.prepare('SELECT fence FROM writers').get()!.fence,2);
      assert.ok(Number(database.prepare('SELECT count(*) AS n FROM captures').get()!.n)>=2);
    }finally{database.close();}
    const health=f.run(['health','--db',db]);assert.equal(health.status,0,health.stderr);
    assert.equal(JSON.parse(health.stdout)[0].currentStatus,'RECORD_ONLY');
  }finally{f.close();}
});
