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
  constructor(private readonly worker:ScheduledWorker&{config:MarketConfig}){
    this.configDigest=createHash('sha256').update(json(worker.config)).digest('hex');
  }
  private accept(result:PollResult):void {
    if(result.worker!==this.worker.config.key||result.configDigest!==this.configDigest)
      throw new Error('SOURCE_SNAPSHOT_BINDING_MISMATCH');
    this.latest=structuredClone(result);
  }
  snapshot():PollResult|null {
    if(this.failure)throw this.failure;
    return this.latest?structuredClone(this.latest):null;
  }
  /** Consumer reads a frozen copy; bootstrap coalesces with the worker's first poll. */
  async poll():Promise<PollResult>{
    const known=this.snapshot();if(known)return known;
    this.accept(await this.worker.poll());return this.snapshot()!;
  }
  async run(signal:AbortSignal):Promise<void>{
    if(this.running)throw new Error('SOURCE_COLLECTOR_ALREADY_RUNNING');
    this.running=true;
    try{await new CollectionService([this.worker]).run(signal,result=>this.accept(result));}
    catch(error){this.failure=error;throw error;}
    finally{this.running=false;}
  }
}
