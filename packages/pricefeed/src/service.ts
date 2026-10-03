import { performance } from 'node:perf_hooks';
import type { PollResult } from './worker.js';

export type ScheduledWorker={config:{key:string;poll:{intervalMs:number}};poll():Promise<PollResult>;shouldPoll?():Promise<boolean>};
function pause(ms:number,signal:AbortSignal):Promise<void> {
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
  });
}
/** Periodic complete snapshots only. Collection never signs or broadcasts. */
export class CollectionService {
  private running=false;
  constructor(private readonly workers:readonly ScheduledWorker[]){
    if(workers.length===0||workers.length>100||new Set(workers.map(w=>w.config.key)).size!==workers.length)throw new Error('BAD_SERVICE_WORKERS');
    for(const w of workers)if(!Number.isSafeInteger(w.config.poll.intervalMs)||w.config.poll.intervalMs<1||w.config.poll.intervalMs>60000)throw new Error('BAD_SERVICE_INTERVAL');
  }
  async run(signal:AbortSignal,onResult:(result:PollResult)=>void|Promise<void>):Promise<void> {
    if(this.running)throw new Error('SERVICE_ALREADY_RUNNING');this.running=true;
    const stop=new AbortController(),forward=()=>stop.abort(signal.reason);
    signal.addEventListener('abort',forward,{once:true});if(signal.aborted)forward();
    try{
      // Independent worker loops: one slow venue request never holds a global poll barrier.
      // Each provider's shared RequestLimiter still controls global source request pressure.
      const operations=this.workers.map(async worker=>{
        try{
          while(!stop.signal.aborted){
            const begun=performance.now();
            if(worker.shouldPoll&&!await worker.shouldPoll())break;
            if(stop.signal.aborted)break;
            const result=await worker.poll();
            await onResult(result); // raw evidence has been archived before this callback.
            const remaining=worker.config.poll.intervalMs-(performance.now()-begun);
            if(remaining>0)await pause(remaining,stop.signal);
          }
        }catch(error){stop.abort(error);throw error;}
      });
      const outcomes=await Promise.allSettled(operations);
      const failure=outcomes.find(r=>r.status==='rejected');
      if(failure?.status==='rejected')throw failure.reason;
    }finally{signal.removeEventListener('abort',forward);this.running=false;}
  }
}
