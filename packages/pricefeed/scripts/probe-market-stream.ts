import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseConfig } from '../src/config.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { Worker } from '../src/worker.js';
import { Journal } from '../src/journal.js';
import { CollectionService } from '../src/service.js';
import { MarketStreamHints, type StreamView } from '../src/market-stream.js';
import { json } from '../src/math.js';

/** Finite public-data-only probe. A fresh diagnostic DB is required; no engine, keys or signing adapter is imported. */
async function main():Promise<void>{
  const [configPath,dbPath,durationArg,reconnectArg,...extra]=process.argv.slice(2);
  if(!configPath||!dbPath||!durationArg||!reconnectArg||extra.length||!/^\d+$/.test(durationArg)||!/^\d+$/.test(reconnectArg))throw new Error('BAD_STREAM_PROBE_ARGUMENTS');
  const duration=Number(durationArg),reconnectAfter=Number(reconnectArg);
  if(duration<30||duration>300||reconnectAfter<10||reconnectAfter>duration-10)throw new Error('BAD_STREAM_PROBE_ARGUMENTS');
  const cfg=parseConfig(JSON.parse(readFileSync(configPath,'utf8')));
  if(cfg.enabled)throw new Error('STREAM_PROBE_DISABLED_CONFIG_REQUIRED');
  if([dbPath,dbPath+'-wal',dbPath+'-shm'].some(existsSync))throw new Error('STREAM_PROBE_FRESH_DB_REQUIRED');
  mkdirSync(dirname(dbPath),{recursive:true});const journal=new Journal(dbPath),stop=new AbortController();
  const worker=new Worker(cfg,new PublicPolymarket(cfg.poll,new RequestLimiter(100,200)),journal,randomUUID());
  const states:StreamView[]=[],stream=new MarketStreamHints([worker],undefined,undefined,view=>states.push(view));
  let captures=0,originalTimestamps=true;const inspections:Record<string,number>={};
  const stopSignal=()=>stop.abort(),timer=setTimeout(stopSignal,duration*1000),reconnect=setTimeout(()=>stream.requestReconnect(),reconnectAfter*1000);
  process.once('SIGINT',stopSignal);process.once('SIGTERM',stopSignal);
  const startedAtUtc=new Date().toISOString();
  try{
    const coupled=(run:Promise<void>)=>run.finally(()=>stop.abort());
    const results=await Promise.allSettled([coupled(stream.run(stop.signal)),coupled(new CollectionService([worker]).run(stop.signal,result=>{
      captures++;inspections[result.inspection.status]=(inspections[result.inspection.status]??0)+1;
      if(result.book&&result.inspection.time){
        const raw=JSON.parse(result.book.body);
        if(String(raw.timestamp)!==String(result.inspection.time.sourceMs)||result.inspection.time.observedAt!==BigInt(raw.timestamp)/1000n)originalTimestamps=false;
      }
      if(result.inspection.engineObservation!==null)throw new Error('STREAM_PROBE_OPERATIONAL_OUTPUT');
    }))]);
    const failure=results.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
  }finally{
    clearTimeout(timer);clearTimeout(reconnect);process.removeListener('SIGINT',stopSignal);process.removeListener('SIGTERM',stopSignal);
    worker.releaseLease();journal.close();
  }
  const retained=new Journal(dbPath,true);let evidenceValid:boolean;
  try{evidenceValid=retained.verify();}finally{retained.close();}
  const final=stream.inspect(),successful=final.connections>=2&&final.pongs>=2&&final.acceptedEvents>0&&captures>=2&&originalTimestamps&&evidenceValid
    &&states.some(s=>s.reason==='STREAM_REQUESTED_RECONNECT');
  console.log(json({mode:'READ_ONLY_MARKET_STREAM_PROBE',startedAtUtc,completedAtUtc:new Date().toISOString(),durationSeconds:duration,
    deliberateReconnectAfterSeconds:reconnectAfter,worker:cfg.key,category:cfg.category,stream:final,states,captures,inspections,
    originalTimestamps,evidenceValid,sourceArchiveSha256:createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
    configSha256:createHash('sha256').update(json(cfg)).digest('hex'),successful,signaturesProduced:0,transactionsSent:0,
    coverageCertified:false,productionApproved:false}));
  if(!successful)process.exitCode=2;
}
main().catch(()=>{console.error('STREAM_PROBE_FAILED');process.exitCode=1;});
