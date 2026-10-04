import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseConfig } from '../src/config.js';
import { parseCalibrationPlan, calibrate } from '../src/calibration.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { Worker, workerNamespace, ensureUniqueWorkers, type PollResult } from '../src/worker.js';
import { CollectionService } from '../src/service.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';

/** Public reads only. No signer, key loader, engine, relay or transaction adapter. */
async function main(){
  const [configPath,planPath,dbPath,outPath,durationArg,restartArg,...extra]=process.argv.slice(2);
  if(!configPath||!planPath||!dbPath||!outPath||!durationArg||!restartArg||extra.length
    ||!/^\d+$/.test(durationArg)||!/^\d+$/.test(restartArg))throw new Error('BAD_SOAK_ARGUMENTS');
  const duration=Number(durationArg),restart=Number(restartArg);
  if(!Number.isSafeInteger(duration)||duration<360||duration>3600||!Number.isSafeInteger(restart)||restart<60||restart>duration-60)
    throw new Error('BAD_SOAK_ARGUMENTS');
  const raw=JSON.parse(readFileSync(configPath,'utf8'));
  if(!Array.isArray(raw)||raw.length<3||raw.length>100)throw new Error('BAD_SOAK_CONFIGS');
  const configs=raw.map(parseConfig);ensureUniqueWorkers(configs);
  if(new Set(configs.map(c=>c.category)).size!==3||configs.some(c=>c.enabled||c.destination!==null||c.pricing.impactMethod!=='vwap'))
    throw new Error('SOAK_DISABLED_READ_ONLY_CATEGORIES_REQUIRED');
  const plan=parseCalibrationPlan(JSON.parse(readFileSync(planPath,'utf8')));
  if([dbPath,dbPath+'-wal',dbPath+'-shm',outPath].some(existsSync))throw new Error('SOAK_FRESH_OUTPUT_REQUIRED');
  mkdirSync(dirname(dbPath),{recursive:true});mkdirSync(dirname(outPath),{recursive:true});
  const limiter=new RequestLimiter(100,200),startedAtMs=BigInt(Date.now()),stop=new AbortController();
  const stopSignal=()=>stop.abort();process.once('SIGINT',stopSignal);process.once('SIGTERM',stopSignal);
  let restartEvidence:{atMs:string;capturesBefore:number;capturesAfterReopen:number}|null=null;
  try{
    for(const [phase,seconds] of [restart,duration-restart].entries()){
      if(stop.signal.aborted)break;
      const journal=new Journal(dbPath),owner=randomUUID();
      const workers=configs.map(cfg=>new Worker(cfg,new PublicPolymarket(cfg.poll,limiter),journal,owner));
      const segment=new AbortController(),forward=()=>segment.abort();stop.signal.addEventListener('abort',forward,{once:true});
      const timer=setTimeout(()=>segment.abort(),seconds*1000);
      try{
        if(phase===1){const count=configs.reduce((n,c)=>n+journal.read(workerNamespace(c)).length,0);
          if(!journal.verify()||!restartEvidence||count!==restartEvidence.capturesBefore)throw new Error('SOAK_RESTART_EVIDENCE_MISMATCH');
          restartEvidence.capturesAfterReopen=count;}
        await new CollectionService(workers).run(segment.signal,result=>{
          if(result.inspection.engineObservation!==null)throw new Error('SOAK_OPERATIONAL_OUTPUT');
        });
        if(phase===0)restartEvidence={atMs:String(Date.now()),capturesBefore:configs.reduce((n,c)=>n+journal.read(workerNamespace(c)).length,0),capturesAfterReopen:0};
      }finally{clearTimeout(timer);stop.signal.removeEventListener('abort',forward);workers.forEach(w=>w.releaseLease());journal.close();}
    }
    const completedAtMs=BigInt(Date.now()),archive=new Journal(dbPath,true);
    let captures:PollResult[];
    try{
      if(!archive.verify())throw new Error('SOAK_ARCHIVE_CHECKSUM');
      captures=configs.flatMap(c=>archive.read(workerNamespace(c)).map(r=>{
        const p=r.payload;
        // Bigints use decimal strings in the durable JSON. Rehydrate only known timing fields.
        for(const field of ['event','metadata','book'] as const){const capture=p[field] as Record<string,unknown>|null;
          if(capture){capture.receivedAtMs=BigInt(String(capture.receivedAtMs));capture.latencyMs=BigInt(String(capture.latencyMs));}}
        return {...p,atMs:r.atMs} as unknown as PollResult;
      }));
    }finally{archive.close();}
    const report={...calibrate(configs,plan,captures,completedAtMs),startedAtMs:startedAtMs.toString(),completedAtMs:completedAtMs.toString(),
      requestedDurationSeconds:duration,elapsedMs:(completedAtMs-startedAtMs).toString(),interrupted:stop.signal.aborted,
      restartEvidence,sourceArchiveSha256:createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
      configsSha256:createHash('sha256').update(json(configs)).digest('hex')};
    writeFileSync(outPath,json(report)+'\n',{flag:'wx'});
    console.log(json({mode:report.mode,interrupted:report.interrupted,markets:report.markets.map(m=>({worker:m.worker,captures:m.captures,statusCounts:m.statusCounts})),signaturesProduced:0,transactionsSent:0}));
    if(stop.signal.aborted)process.exitCode=2;
  }finally{process.removeListener('SIGINT',stopSignal);process.removeListener('SIGTERM',stopSignal);}
}
main().catch(()=>{console.error('READ_ONLY_SOAK_FAILED');process.exitCode=1;});
