import { createHash } from 'node:crypto';
import { metadataIdentity, verifyEventMembership, inspectSnapshot, type Inspection, type MetadataIdentity } from './collector.js';
import type { MarketConfig } from './config.js';
import type { Capture } from './polymarket.js';
import { Journal } from './journal.js';
import { json } from './math.js';

export type Provider={event(id:string):Promise<Capture>;metadata(id:string):Promise<Capture>;book(id:string):Promise<Capture>};
export type PollResult={worker:string;category:string;atMs:bigint;configDigest:string;inspection:Inspection;
  event:Capture|null;metadata:Capture|null;book:Capture|null;baselineRulesDigest:string|null;lastSourceMs:bigint|null};

export function workerNamespace(cfg:MarketConfig):string {
  const d=cfg.destination;
  return d?`${d.chainId}:${d.engineAddress.toLowerCase()}:${d.marketId}:${d.sourceId}`
    :`readonly:${cfg.mapping.conditionId}:${cfg.mapping.outcomeTokenId}`;
}
export function ensureUniqueWorkers(configs:MarketConfig[]):void {
  const namespaces=new Set<string>(),keys=new Set<string>();
  for(const cfg of configs){const ns=workerNamespace(cfg);if(namespaces.has(ns)||keys.has(cfg.key))throw new Error('DUPLICATE_WORKER_DOMAIN_OR_KEY');namespaces.add(ns);keys.add(cfg.key);}
}

export class Worker {
  readonly namespace:string;
  private metadataCapture:Capture|null=null;
  private eventCapture:Capture|null=null;
  private metadata:MetadataIdentity|null=null;
  private lastSourceMs:bigint|null=null;
  private rulesDigest:string|null=null;
  private quarantined:string|null=null;
  private current:Promise<PollResult>|null=null;
  private fence=0n;
  private readonly configDigest:string;
  constructor(readonly config:MarketConfig,private readonly provider:Provider,private readonly journal:Journal,
    private readonly owner:string,private readonly now:()=>bigint=()=>BigInt(Date.now())) {
    this.namespace=workerNamespace(config);
    this.configDigest=createHash('sha256').update(json(config)).digest('hex');
    const previous=journal.latest(this.namespace)?.payload;
    if(previous){
      if(previous.configDigest!==this.configDigest)this.quarantined='CONFIG_CHANGED_REVIEW_REQUIRED';
      if(typeof previous.lastSourceMs==='string')this.lastSourceMs=BigInt(previous.lastSourceMs);
      if(typeof previous.baselineRulesDigest==='string')this.rulesDigest=previous.baselineRulesDigest;
      const inspection=previous.inspection;
      if(inspection&&typeof inspection==='object'&&'status' in inspection&&inspection.status==='QUARANTINED')this.quarantined='RESTORED_QUARANTINE';
    }
  }
  poll():Promise<PollResult> {
    // Stream hints or timer ticks coalesce into one full snapshot per worker.
    if(this.current)return this.current;
    const operation=this.collect();this.current=operation;
    void operation.finally(()=>{if(this.current===operation)this.current=null;}).catch(()=>{});
    return operation;
  }
  releaseLease():boolean {
    if(this.current)throw new Error('WORKER_POLL_IN_FLIGHT');
    if(!this.fence)return false;
    const released=this.journal.release(this.namespace,this.owner,this.fence);this.fence=0n;return released;
  }
  private async collect():Promise<PollResult> {
    const ttl=BigInt((this.config.poll.timeoutMs+this.config.poll.retryDelayMs*8)*
      (this.config.poll.maxRetries+1)*3+this.config.poll.intervalMs+10000);
    const fence=this.journal.acquire(this.namespace,this.owner,this.now(),ttl);
    this.fence=fence;
    let book:Capture|null=null;
    let inspection:Inspection={status:'DEGRADED',reason:null,time:null,summary:null,engineObservation:null};
    try {
      if(this.quarantined){inspection.status='QUARANTINED';inspection.reason=this.quarantined;}
      else {
        if(!this.metadataCapture||this.now()-this.metadataCapture.receivedAtMs>BigInt(this.config.poll.metadataMaxAgeMs)/2n){
          this.eventCapture=await this.provider.event(this.config.mapping.eventId);
          const event=verifyEventMembership(this.config,this.eventCapture.data);
          const fresh=await this.provider.metadata(this.config.mapping.externalMarketId);
          // Preserve rejected metadata as evidence before identity validation.
          this.metadataCapture=fresh;const market=metadataIdentity(this.config,fresh.data);
          this.metadata={tradeable:market.tradeable&&event.tradeable,
            rulesDigest:createHash('sha256').update(`${event.rulesDigest}:${market.rulesDigest}`).digest('hex')};
        }
        book=await this.provider.book(this.config.mapping.outcomeTokenId);
        const metadataAt=this.eventCapture!.receivedAtMs<this.metadataCapture!.receivedAtMs
          ?this.eventCapture!.receivedAtMs:this.metadataCapture!.receivedAtMs;
        inspection=inspectSnapshot(this.config,book.data,book.receivedAtMs,this.lastSourceMs,this.metadata!,metadataAt,this.rulesDigest??undefined);
        if(this.rulesDigest===null)this.rulesDigest=this.metadata!.rulesDigest;
        if(inspection.time?.monotone)this.lastSourceMs=inspection.time.sourceMs;
        if(inspection.status==='QUARANTINED')this.quarantined=inspection.reason;
      }
    }catch(error){
      inspection.reason=error instanceof Error?error.message:String(error);
      if(/IDENTITY|OUTCOME_MAPPING|SOURCE_RULES/.test(inspection.reason)){inspection.status='QUARANTINED';this.quarantined=inspection.reason;}
    }
    const result:PollResult={worker:this.config.key,category:this.config.category,atMs:this.now(),configDigest:this.configDigest,
      inspection,event:this.eventCapture,metadata:this.metadataCapture,book,baselineRulesDigest:this.rulesDigest,lastSourceMs:this.lastSourceMs};
    // A fenced/expired journal failure propagates, preventing a false healthy status.
    this.journal.append(this.namespace,this.owner,fence,this.now(),result);
    return result;
  }
}
