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

function args(argv:string[]):{command:string;options:Map<string,string>} {
  const [command,...rest]=argv;if(!command)throw new Error('COMMAND_REQUIRED');
  const options=new Map<string,string>();
  for(let i=0;i<rest.length;i+=2){const key=rest[i],value=rest[i+1];if(!key?.startsWith('--')||value===undefined||options.has(key))throw new Error('BAD_OR_DUPLICATE_ARGUMENT');options.set(key,value);}
  return {command,options};
}
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8')) as unknown;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

async function main():Promise<void> {
  const {command,options}=args(process.argv.slice(2));
  const allowed:Record<string,string[]>={'validate-config':['--config'],'inspect-book':['--config','--db'],'capture':['--configs','--duration-seconds','--db'],'health':['--db'],'verify-evidence':['--db'],'verify-digest':['--observation','--chain-id','--engine']};
  if(!allowed[command])throw new Error('UNKNOWN_COMMAND: only read-only inspection is implemented');
  for(const key of options.keys())if(!allowed[command]!.includes(key))throw new Error(`UNSUPPORTED_OPTION_${key}`);
  const need=(key:string)=>{const v=options.get(key);if(!v)throw new Error(`REQUIRED_${key}`);return v;};
  if(command==='verify-digest'){const chain=need('--chain-id');if(!/^[1-9]\d*$/.test(chain))throw new Error('BAD_CHAIN_ID');console.log(json({digest:observationDigest(parseObservation(read(need('--observation'))),BigInt(chain),need('--engine')),sent:false}));return;}
  if(command==='validate-config'){const cfg=parseConfig(read(need('--config')));console.log(json({valid:true,category:cfg.category,enabled:cfg.enabled,operationalOutput:false,openApprovals:Object.entries(cfg.policies).filter(([k,v])=>k.endsWith('ApprovalId')&&v===null).map(([k])=>k)}));return;}
  const path=options.get('--db')??'var/diagnostic.sqlite';mkdirSync(dirname(path),{recursive:true});const journal=new Journal(path);
  try{
    if(command==='verify-evidence'){if(!journal.verify())throw new Error('EVIDENCE_INTEGRITY_FAILURE');console.log(json({valid:true,workers:journal.workers()}));return;}
    if(command==='health'){console.log(json(journal.workers().map(worker=>healthView(journal.latest(worker)!.payload,BigInt(Date.now())))));return;}
    const raw=command==='capture'?read(need('--configs')):[read(need('--config'))];
    if(!Array.isArray(raw)||raw.length===0||raw.length>100)throw new Error('CONFIG_ARRAY_REQUIRED_1_TO_100');
    const configs=raw.map(parseConfig);ensureUniqueWorkers(configs);
    const limiter=new RequestLimiter(100,200),owner=randomUUID();
    const workers=configs.map(c=>new Worker(c,new PublicPolymarket(c.poll,limiter),journal,owner));
    if(command==='inspect-book'){const result=await workers[0]!.poll();console.log(json({...result,metadata:result.metadata?{url:result.metadata.url,receivedAtMs:result.metadata.receivedAtMs,attempts:result.metadata.attempts}:null,book:result.book?{url:result.book.url,receivedAtMs:result.book.receivedAtMs,latencyMs:result.book.latencyMs,attempts:result.book.attempts,sha256:createHash('sha256').update(result.book.body).digest('hex')}:null}));if(result.inspection.status!=='COLLECTING')process.exitCode=2;return;}
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
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
