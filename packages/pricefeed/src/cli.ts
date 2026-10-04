import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { parseConfig } from './config.js';
import { Journal } from './journal.js';
import { json } from './math.js';
import { PublicPolymarket, RequestLimiter } from './polymarket.js';
import { Worker, ensureUniqueWorkers } from './worker.js';
import { observationDigest, parseObservation } from './wire.js';
import { healthView } from './health.js';
import { CollectionService } from './service.js';
import { buildArchivedObservation } from './offline-observation.js';
import { parseRules } from './rules.js';
import { monadTestnetReadRpc, preflightMonadTestnet } from './monad-preflight.js';
import { monadLifecycleReader, watchMonadLifecycle } from './monad-lifecycle.js';
import { MonadTestnetLifecycleMonitor, type LifecycleView } from './lifecycle.js';
import { parseTestnetRunPolicy, runMonadTestnetService } from './monad-service.js';
import { quoteMonadGas } from './monad-gas-quote.js';
import { planMonadBudget, applyMonadBudget } from './monad-budget.js';

function args(argv:string[]):{command:string;options:Map<string,string>} {
  const [command,...rest]=argv;if(!command)throw new Error('COMMAND_REQUIRED');
  const options=new Map<string,string>();
  for(let i=0;i<rest.length;i+=2){const key=rest[i],value=rest[i+1];if(!key?.startsWith('--')||value===undefined||options.has(key))throw new Error('BAD_OR_DUPLICATE_ARGUMENT');options.set(key,value);}
  return {command,options};
}
const read=(path:string)=>{const body=readFileSync(path,'utf8');try{return JSON.parse(body) as unknown;}catch{throw new Error('INVALID_JSON_INPUT');}};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

async function main():Promise<void> {
  const {command,options}=args(process.argv.slice(2));
  const allowed:Record<string,string[]>={'validate-config':['--config'],'inspect-book':['--config','--db'],'capture':['--configs','--duration-seconds','--db'],'serve':['--configs','--db'],'health':['--db'],'verify-evidence':['--db'],'verify-digest':['--observation','--chain-id','--engine'],
    'build-observation':['--config','--rules','--db','--capture-id','--sequence','--published-at-ms'],
    'preflight-monad':['--rpc-env','--config','--abi'],
    'watch-monad-lifecycle':['--rpc-env','--config','--abi','--db','--interval-ms','--max-checkpoint-age-ms','--duration-seconds'],
    'serve-monad-testnet':['--rpc-env','--config','--rules','--abi','--keys-dir','--journal-dir','--policy','--duration-seconds','--stop-after-finalized','--initialize'],
    'quote-monad-gas':['--rpc-env','--config','--rules','--abi','--keys-dir','--journal-dir','--policy'],
    'plan-monad-budget':['--rpc-env','--config','--abi','--journal-dir','--old-policy','--new-policy','--transition-id','--reason'],
    'apply-monad-budget':['--rpc-env','--config','--abi','--journal-dir','--plan','--plan-sha256']};
  if(!Object.hasOwn(allowed,command))throw new Error('UNKNOWN_COMMAND');
  for(const key of options.keys())if(!allowed[command]!.includes(key))throw new Error('UNSUPPORTED_OPTION');
  const need=(key:string)=>{const v=options.get(key);if(!v)throw new Error(`REQUIRED_${key}`);return v;};
  if(command==='plan-monad-budget'||command==='apply-monad-budget'){
    const name=need('--rpc-env');if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('MONAD_BAD_RPC_ENV_NAME');
    const rpcUrl=process.env[name];if(!rpcUrl)throw new Error('MONAD_RPC_ENV_MISSING');
    const setup={rpcUrl,config:parseConfig(read(need('--config'))),abi:read(need('--abi')),journalDirectory:need('--journal-dir')};
    console.log(json(command==='plan-monad-budget'
      ?await planMonadBudget(setup,read(need('--old-policy')),read(need('--new-policy')),need('--transition-id'),need('--reason'))
      :await applyMonadBudget(setup,read(need('--plan')),need('--plan-sha256'))));return;
  }
  if(command==='quote-monad-gas'){
    const name=need('--rpc-env');if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('MONAD_BAD_RPC_ENV_NAME');
    const rpcUrl=process.env[name];if(!rpcUrl)throw new Error('MONAD_RPC_ENV_MISSING');
    console.log(json(await quoteMonadGas({config:parseConfig(read(need('--config'))),rules:parseRules(read(need('--rules'))),
      abi:read(need('--abi')),rpcUrl,keysDirectory:need('--keys-dir'),journalDirectory:need('--journal-dir'),
      policy:parseTestnetRunPolicy(read(need('--policy')))})));return;
  }
  if(command==='serve-monad-testnet'){
    const name=need('--rpc-env');if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('MONAD_BAD_RPC_ENV_NAME');
    const rpcUrl=process.env[name];if(!rpcUrl)throw new Error('MONAD_RPC_ENV_MISSING');
    const duration=need('--duration-seconds'),target=need('--stop-after-finalized'),initialize=need('--initialize');
    if(!/^[1-9]\d*$/.test(duration)||BigInt(duration)>86400n||!/^([1-9]\d*)$/.test(target)||BigInt(target)>100000n
      ||!['true','false'].includes(initialize))throw new Error('BAD_TESTNET_RUN_LIMIT');
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{
      const result=await runMonadTestnetService({config:parseConfig(read(need('--config'))),rules:parseRules(read(need('--rules'))),
        abi:read(need('--abi')),rpcUrl,keysDirectory:need('--keys-dir'),journalDirectory:need('--journal-dir'),
        policy:parseTestnetRunPolicy(read(need('--policy'))),durationSeconds:Number(duration),stopAfterFinalized:Number(target),
        initialize:initialize==='true'},controller.signal,r=>console.log(json({mode:'MONAD_TESTNET_DIAGNOSTIC_PUBLICATION',...r})));
      console.log(json(result));
      if(!result.evidenceValid||Number(result.finalizedPackets)<Number(target))process.exitCode=2;
    }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    return;
  }
  if(command==='preflight-monad'){
    const name=need('--rpc-env');if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('MONAD_BAD_RPC_ENV_NAME');
    const rpcUrl=process.env[name];if(!rpcUrl)throw new Error('MONAD_RPC_ENV_MISSING');
    if(options.has('--config')!==options.has('--abi'))throw new Error('MONAD_CONFIG_AND_ABI_REQUIRED_TOGETHER');
    const engine=options.has('--config')?{config:parseConfig(read(need('--config'))),abi:read(need('--abi'))}:undefined;
    console.log(json(await preflightMonadTestnet(monadTestnetReadRpc(rpcUrl),engine)));return;
  }
  if(command==='watch-monad-lifecycle'){
    const name=need('--rpc-env');if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('MONAD_BAD_RPC_ENV_NAME');
    const url=process.env[name];if(!url)throw new Error('MONAD_RPC_ENV_MISSING');
    const bounded=(key:string,min:bigint,max:bigint)=>{const raw=need(key);
      if(!/^[1-9]\d*$/.test(raw)||BigInt(raw)<min||BigInt(raw)>max)throw new Error('MONAD_BAD_MONITOR_POLICY');return Number(raw);};
    const interval=bounded('--interval-ms',1000n,60000n),maxAge=bounded('--max-checkpoint-age-ms',1000n,30000n),
      duration=bounded('--duration-seconds',1n,86400n),cfg=parseConfig(read(need('--config'))),abi=read(need('--abi'));
    // Validate the entire dossier and policy before creating any on-disk archive.
    const reader=monadLifecycleReader(monadTestnetReadRpc(url),cfg,abi),path=need('--db');
    mkdirSync(dirname(path),{recursive:true});const journal=new Journal(path),controller=new AbortController();
    const stop=()=>controller.abort(),timer=setTimeout(stop,duration*1000);
    process.once('SIGINT',stop);process.once('SIGTERM',stop);const outcome:{checks:number;last:LifecycleView|null}={checks:0,last:null};
    let monitor:MonadTestnetLifecycleMonitor|null=null;
    try{
      monitor=new MonadTestnetLifecycleMonitor(cfg,journal,randomUUID(),reader,BigInt(maxAge));
      await watchMonadLifecycle(monitor,interval,controller.signal,view=>{outcome.checks++;outcome.last=view;
        console.log(json({mode:'MONAD_TESTNET_READ_ONLY',worker:cfg.key,lifecycle:view,operationalOutput:false,signaturesProduced:0,transactionsSent:0}));});
      console.log(json({completed:true,checks:outcome.checks,lastMode:outcome.last?.mode??null,evidenceValid:journal.verify(),
        operationalOutput:false,signaturesProduced:0,transactionsSent:0}));
      if(outcome.last?.mode==='QUARANTINED'||outcome.last?.mode==='DEGRADED')process.exitCode=2;
    }finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
      try{monitor?.releaseLease();}finally{journal.close();}}
    return;
  }
  if(command==='build-observation'){
    const result=buildArchivedObservation(parseConfig(read(need('--config'))),parseRules(read(need('--rules'))),
      need('--db'),need('--capture-id'),need('--sequence'),need('--published-at-ms'));
    console.log(json(result));if(!result.available)process.exitCode=2;return;
  }
  if(command==='verify-digest'){const chain=need('--chain-id');if(!/^[1-9]\d*$/.test(chain))throw new Error('BAD_CHAIN_ID');console.log(json({digest:observationDigest(parseObservation(read(need('--observation'))),BigInt(chain),need('--engine')),sent:false}));return;}
  if(command==='validate-config'){const cfg=parseConfig(read(need('--config')));console.log(json({valid:true,category:cfg.category,enabled:cfg.enabled,operationalOutput:false,openApprovals:Object.entries(cfg.policies).filter(([k,v])=>k.endsWith('ApprovalId')&&v===null).map(([k])=>k)}));return;}
  const path=options.get('--db')??'var/diagnostic.sqlite';mkdirSync(dirname(path),{recursive:true});const journal=new Journal(path);
  try{
    if(command==='verify-evidence'){if(!journal.verify())throw new Error('EVIDENCE_INTEGRITY_FAILURE');console.log(json({valid:true,workers:journal.workers()}));return;}
    if(command==='health'){console.log(json(journal.workers().map(worker=>healthView(journal.latest(worker)!.payload,BigInt(Date.now())))));return;}
    const raw=command==='capture'||command==='serve'?read(need('--configs')):[read(need('--config'))];
    if(!Array.isArray(raw)||raw.length===0||raw.length>100)throw new Error('CONFIG_ARRAY_REQUIRED_1_TO_100');
    const configs=raw.map(parseConfig);ensureUniqueWorkers(configs);
    const limiter=new RequestLimiter(100,200),owner=randomUUID();
    const workers=configs.map(c=>new Worker(c,new PublicPolymarket(c.poll,limiter),journal,owner));
    if(command==='inspect-book'){const result=await workers[0]!.poll();console.log(json({...result,event:result.event?{url:result.event.url,receivedAtMs:result.event.receivedAtMs,attempts:result.event.attempts}:null,metadata:result.metadata?{url:result.metadata.url,receivedAtMs:result.metadata.receivedAtMs,attempts:result.metadata.attempts}:null,book:result.book?{url:result.book.url,receivedAtMs:result.book.receivedAtMs,latencyMs:result.book.latencyMs,attempts:result.book.attempts,sha256:createHash('sha256').update(result.book.body).digest('hex')}:null}));if(result.inspection.status!=='COLLECTING')process.exitCode=2;return;}
    if(command==='serve'){
      const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{await new CollectionService(workers).run(controller.signal,result=>{console.log(json({worker:result.worker,category:result.category,atMs:result.atMs,inspection:result.inspection}));});}
      finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
      console.log(json({completed:true,signaturesProduced:0,transactionsSent:0,evidenceValid:journal.verify()}));return;
    }
    const seconds=need('--duration-seconds');if(!/^[1-9]\d*$/.test(seconds)||BigInt(seconds)>86400n)throw new Error('DURATION_REQUIRED_1_TO_86400_SECONDS');
    const durationMs=BigInt(seconds)*1000n,start=process.hrtime.bigint();let stopped=false;
    const stop=()=>{stopped=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{
      await Promise.all(workers.map(async worker=>{
        for(;;){const begun=process.hrtime.bigint();if(stopped||(begun-start)/1000000n>durationMs)break;
          const result=await worker.poll();console.log(json({worker:result.worker,category:result.category,atMs:result.atMs,inspection:result.inspection}));
          const elapsed=Number((process.hrtime.bigint()-begun)/1000000n);const pause=Math.max(0,worker.config.poll.intervalMs-elapsed);
          if((process.hrtime.bigint()-start)/1000000n+BigInt(pause)>durationMs)break;
          if(pause)await sleep(pause);
        }
      }));
    }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    console.log(json({completed:true,signaturesProduced:0,transactionsSent:0,evidenceValid:journal.verify()}));
  }finally{journal.close();}
}
main().catch(error=>{
  // Only fixed diagnostic codes leave the CLI; parser/OS messages can contain input or paths.
  const message=error instanceof Error?error.message:'';
  console.error(/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?(?:--[a-z-]+)?$/.test(message)?message:'COMMAND_FAILED');
  process.exitCode=1;
});
