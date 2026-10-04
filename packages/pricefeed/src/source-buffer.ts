import { createHash } from 'node:crypto';
import type { MarketConfig } from './config.js';
import { json } from './math.js';
import { CollectionService, type ScheduledWorker } from './service.js';
import type { PollResult } from './worker.js';

/** One archived snapshot per worker, replaced only by its own newer collection.
 * No queue of stale books, signing, timestamp changes or transaction operations.
 */
export class SourceSnapshotBuffer {
  private latest:PollResult|null=null;
  private failure:unknown=null;
  private running=false;
  private readonly configDigest:string;
  private latestRevision=-1;
  private current:Promise<PollResult>|null=null;
  constructor(private readonly worker:ScheduledWorker&{config:MarketConfig}){
    this.configDigest=createHash('sha256').update(json(worker.config)).digest('hex');
  }
  private accept(result:PollResult,revision:number):void {
    if(result.worker!==this.worker.config.key||result.configDigest!==this.configDigest)
      throw new Error('SOURCE_SNAPSHOT_BINDING_MISMATCH');
    if(revision!==(this.worker.refresh?.resyncRevision??0))return;
    this.latest=structuredClone(result);this.latestRevision=revision;
  }
  snapshot():PollResult|null {
    if(this.failure)throw this.failure;
    return this.latest&&this.latestRevision===(this.worker.refresh?.resyncRevision??0)?structuredClone(this.latest):null;
  }
  publicationReady():boolean {
    if(this.failure)throw this.failure;
    return this.latest!==null&&this.latestRevision===(this.worker.refresh?.resyncRevision??0)
      &&(this.latest.inspection.status==='COLLECTING'||this.latest.inspection.status==='INVALID_DEPTH');
  }
  private collect():Promise<PollResult>{
    if(this.current)return this.current;
    const revision=this.worker.refresh?.resyncRevision??0;
    const operation=this.worker.poll().then(result=>{this.accept(result,revision);return result;});this.current=operation;
    void operation.finally(()=>{if(this.current===operation)this.current=null;}).catch(()=>{});return operation;
  }
  /** Consumer reads a frozen copy; bootstrap coalesces with the worker's first poll. */
  async poll():Promise<PollResult>{
    const known=this.snapshot();if(known)return known;
    const result=await this.collect();return this.snapshot()??{...result,
      inspection:{status:'DEGRADED',reason:'STREAM_RESYNC_REQUIRED',time:null,summary:null,engineObservation:null}};
  }
  async run(signal:AbortSignal):Promise<void>{
    if(this.running)throw new Error('SOURCE_COLLECTOR_ALREADY_RUNNING');
    this.running=true;
    const scheduled={config:this.worker.config,poll:()=>this.collect(),...(this.worker.refresh?{refresh:this.worker.refresh}:{}),
      ...(this.worker.shouldPoll?{shouldPoll:()=>this.worker.shouldPoll!()}: {})};
    try{await new CollectionService([scheduled]).run(signal,()=>{});}
    catch(error){this.failure=error;throw error;}
    finally{this.running=false;}
  }
}
