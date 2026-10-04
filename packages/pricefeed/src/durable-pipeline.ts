import { randomUUID } from 'node:crypto';
import { parseConfig, verifyListing, type MarketConfig } from './config.js';
import { json } from './math.js';
import { PacketStore, packetNamespace, type PacketDomain, type StoredPacket } from './packet-store.js';
import { prepareObservation, permitsInvalidDepth, signPrepared, type RawSigner } from './publication.js';
import { parseRules, rulesHash, type RulesManifest } from './rules.js';
import { DurableRelay, type LocalRelayTransport, type RelayPolicy, type DeliveryRecord } from './durable-relay.js';
import { CollectionService, type ScheduledWorker } from './service.js';
import type { PollResult } from './worker.js';
import { sourceTime } from './time.js';
import type { LifecycleView } from './lifecycle.js';
export type PipelineLifecycle={assertConfig(config:MarketConfig):void;check():Promise<LifecycleView>;releaseLease?():boolean};

export type RecoverableSigner=RawSigner&{reconcile(owner:string,fence:bigint,chain:{lastSequence:bigint;lastObservedAt:bigint}):void};
export type PipelineWorker={worker:ScheduledWorker&{config:MarketConfig;releaseLease?():boolean};rules:RulesManifest;signer:RecoverableSigner;lifecycle?:PipelineLifecycle};
type Entry=PipelineWorker&{config:MarketConfig;domain:PacketDomain;fence:bigint;pending:bigint[];watch:bigint[];quarantined:string|null;lifecycleView:LifecycleView|null};
export type PipelineResult={worker:string;state:'SOURCE_UNAVAILABLE'|'QUARANTINED'|'STOPPED'|'EXPIRED'|'UNKNOWN'|'MINED'|'FINALIZED';
  reason:string|null;sequence:bigint|null;transactionHash:string|null;depthValid:boolean|null;lifecycle:LifecycleView|null};
class LifecycleBlocked extends Error {
  constructor(readonly result:PipelineResult){super(`LIFECYCLE_BLOCKED:${result.state}:${result.reason}`);}
}

/** Shared joined diagnostic pipeline mechanics; public wrappers fix network and builder/signing paths. */
export class DurablePipeline {
  private readonly owner=randomUUID();
  private readonly entries=new Map<string,Entry>();
  private readonly busy=new Set<string>();
  private tail:Promise<unknown>=Promise.resolve();
  private started=false;
  private running=false;
  private starting=false;
  private closed=false;
  protected constructor(workers:readonly PipelineWorker[],private readonly packets:PacketStore,private readonly relay:DurableRelay,
    private readonly transport:LocalRelayTransport,private readonly policy:RelayPolicy,
    private readonly now:()=>bigint,
    private readonly network:{chainId:31337n|10143n;prepare:typeof prepareObservation;sign:typeof signPrepared}){
    if(workers.length===0||workers.length>100)throw new Error('BAD_PIPELINE_WORKERS');
    if(policy.leaseMs>3600000n)throw new Error('BAD_PIPELINE_LEASE');
    const domains=new Set<string>();
    for(const input of workers){
      const config=parseConfig(JSON.parse(json(input.worker.config))),d=config.destination,rules=parseRules(input.rules);
      if(config.enabled||!d||d.chainId!==network.chainId.toString())throw new Error('LOCAL_DISABLED_CONFIG_ONLY');
      if(input.signer.address.toLowerCase()!==d.signerAddress.toLowerCase()||rulesHash(rules)!==d.sourceRulesHash.toLowerCase())throw new Error('PIPELINE_RULES_OR_SIGNER_MISMATCH');
      input.lifecycle?.assertConfig(config);
      if(config.requiredFeedUntil!==null&&!input.lifecycle)throw new Error('PIPELINE_LIFECYCLE_REQUIRED');
      const domain:PacketDomain={chainId:network.chainId,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
      const ns=packetNamespace(domain);
      if(this.entries.has(config.key)||domains.has(ns))throw new Error('DUPLICATE_PIPELINE_WORKER');domains.add(ns);
      this.entries.set(config.key,{...input,config,rules,domain,fence:0n,pending:[],watch:[],quarantined:null,lifecycleView:null});
    }
  }
  private async bounded<T>(op:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([op,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('PIPELINE_TIMEOUT')),this.policy.timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{
    const operation=this.tail.then(fn);this.tail=operation.catch(()=>{});return operation;
  }
  private async identity(e:Entry){
    const i=await this.bounded(this.transport.identity(e.domain)),d=e.config.destination!;
    if(i.chainId!==this.network.chainId||i.engineCodeHash.toLowerCase()!==d.engineCodeHash.toLowerCase()
      ||i.abiHash.toLowerCase()!==d.abiHash.toLowerCase()||i.signer.toLowerCase()!==d.signerAddress.toLowerCase()
      ||i.rulesHash.toLowerCase()!==d.sourceRulesHash.toLowerCase())throw new Error('PIPELINE_IDENTITY_MISMATCH');
    verifyListing(e.config,i.listing);
    if(this.network.chainId===10143n)this.signedHistory(e,i);
    return i;
  }
  private signedHistory(e:Entry,state:{lastSequence:bigint;lastObservedAt:bigint}):void {
    try{
      e.signer.reconcile(this.owner,e.fence,state);
      const finalized=this.packets.list(e.domain).filter(p=>this.relay.get(e.domain,p.packet.observation.sequence)?.state==='FINALIZED');
      if(finalized.some(p=>p.packet.observation.sequence>state.lastSequence))throw new Error('FINALIZED_SOURCE_REGRESSION');
    }catch(error){this.relay.quarantine('SIGNED_SOURCE_HISTORY_MISMATCH');throw error;}
  }
  async start():Promise<void>{
    if(this.closed||this.started||this.running||this.starting)throw new Error('PIPELINE_ALREADY_STARTED_OR_CLOSED');
    this.starting=true;
    try{
      await this.relay.start();
      for(const e of this.entries.values()){
        e.fence=this.packets.acquire(e.domain,this.owner,this.now(),this.policy.leaseMs);
        const chain=await this.identity(e);e.signer.reconcile(this.owner,e.fence,chain);
        const history=this.packets.list(e.domain);e.pending=[];e.watch=[];
        for(const p of history){
          if(p.state==='EXPIRED'||this.relay.get(e.domain,p.packet.observation.sequence)?.state==='CANCELLED')continue;
          const seq=p.packet.observation.sequence,r=this.relay.get(e.domain,seq);
          if(r?.state==='QUARANTINED'||r?.state==='REVERTED'
            ||r?.state==='PREPARING'&&!this.relay.canResumePreparing(e.domain,seq))throw new Error('PIPELINE_DELIVERY_RECOVERY_REQUIRED');
          if(r?.state==='MINED'||r?.state==='FINALIZED')e.watch.push(seq);
          else e.pending.push(seq);
        }
        // Retain all unfinalized receipts and the newest finalized receipt for reorg checks.
        const finalized=e.watch.filter(seq=>this.relay.get(e.domain,seq)?.state==='FINALIZED');
        e.watch=e.watch.filter(seq=>!finalized.includes(seq)||seq===finalized.at(-1));
      }
      this.started=true;
    }catch(error){this.release();throw error;}finally{this.starting=false;}
  }
  renew():void {
    if(!this.started||this.closed)throw new Error('PIPELINE_START_REQUIRED');
    this.relay.renew();
    for(const e of this.entries.values()){
      this.packets.assertWriter(e.domain,this.owner,e.fence,this.now());
      if(this.packets.acquire(e.domain,this.owner,this.now(),this.policy.leaseMs)!==e.fence)throw new Error('PIPELINE_FENCE_CHANGED');
    }
  }
  private result(e:Entry,state:PipelineResult['state'],reason:string|null,sequence:bigint|null=null,r?:DeliveryRecord):PipelineResult {
    return {worker:e.config.key,state,reason,sequence,transactionHash:r?.txHash??null,depthValid:r?.accepted?.depthValid??null,lifecycle:e.lifecycleView};
  }
  private async lifecycleGate(e:Entry):Promise<PipelineResult|null>{
    if(!e.lifecycle)return null;
    const view=await this.bounded(e.lifecycle.check());e.lifecycleView=view;
    if(this.network.chainId===10143n&&(view.mode==='COLLECTING'||view.mode==='RECORD_ONLY')){
      if(!view.checkpoint?.sourceState){this.relay.quarantine('SOURCE_CHECKPOINT_MISSING');throw new Error('SOURCE_CHECKPOINT_MISSING');}
      this.signedHistory(e,view.checkpoint.sourceState);
    }
    if(view.mode==='STOPPED')return this.result(e,'STOPPED',view.reason);
    if(view.mode==='QUARANTINED')return this.result(e,'QUARANTINED',view.reason);
    if(view.mode==='DEGRADED')return this.result(e,'SOURCE_UNAVAILABLE',view.reason);
    return null; // RECORD_ONLY uses the identical authenticated observation path.
  }
  private accepted(e:Entry,seq:bigint):void {
    e.pending=e.pending.filter(v=>v!==seq);
    if(!e.watch.includes(seq))e.watch.push(seq);
    e.watch=e.watch.filter(v=>this.relay.get(e.domain,v)?.state!=='FINALIZED'||v===seq);
  }
  private expireUnsent(e:Entry,p:StoredPacket):PipelineResult|null {
    const seq=p.packet.observation.sequence;
    if(this.relay.get(e.domain,seq)||sourceTime(p.packet.sourceMs.toString(),this.now(),null,this.policy.headroomMs).hasHeadroom)return null;
    this.packets.expire(e.domain,this.owner,e.fence,this.now(),seq,'UNSENT_HEADROOM_EXPIRED');
    e.pending=e.pending.filter(v=>v!==seq);
    return this.result(e,'EXPIRED','UNSENT_HEADROOM_EXPIRED',seq);
  }
  private async publish(e:Entry,p:StoredPacket,checkedAt?:bigint):Promise<PipelineResult>{
    const seq=p.packet.observation.sequence;
    // A newly allocated packet reaches here synchronously after process's gate.
    // Reuse only within 50 ms and the same whole second; a delay or time
    // boundary demands a fresh check. All
    // post-signing, pre-reservation and pre-broadcast gates still run normally.
    const at=this.now(),sameGate=checkedAt!==undefined&&at>=checkedAt&&at-checkedAt<=50n&&at/1000n===checkedAt/1000n;
    const blocked=sameGate?null:await this.lifecycleGate(e);if(blocked)return blocked;
    const expired=this.expireUnsent(e,p);if(expired)return expired;
    if(p.state!=='SIGNED')p=await this.bounded(this.network.sign(this.packets,e.domain,this.owner,e.fence,seq,e.signer,this.now,this.policy.headroomMs));
    if(p.state==='EXPIRED'){e.pending=e.pending.filter(v=>v!==seq);return this.result(e,'EXPIRED',p.reason,seq);}
    return this.serialized(async()=>{
      const blocked=await this.lifecycleGate(e);if(blocked)return blocked;
      // Other markets may consume the publication budget while this task waits.
      // An unreserved stale update is a normal expiry, not a service-wide failure.
      const expired=this.expireUnsent(e,p);if(expired)return expired;
      this.relay.renew();let r=this.relay.get(e.domain,seq);
      if(r?.txHash)r=await this.relay.reconcile(e.config,seq);
      if(!r||!['MINED','FINALIZED'].includes(r.state)){
        try{r=await this.relay.deliver(e.config,this.owner,e.fence,seq,e.lifecycle?async()=>{
          const blocked=await this.lifecycleGate(e);if(blocked)throw new LifecycleBlocked(blocked);
        }:undefined);}catch(error){
          if(error instanceof LifecycleBlocked)return error.result;
          if(error instanceof Error&&error.message==='RELAY_HEADROOM_EXPIRED'){
            // A slow identity/simulation/guard can also exhaust headroom before
            // nonce reservation. Reserved deliveries retain relay quarantine.
            const expired=this.expireUnsent(e,p);if(expired)return expired;
          }
          throw error;
        }
      }
      if(r.state==='UNKNOWN')r=await this.relay.reconcile(e.config,seq);
      if(!['UNKNOWN','MINED','FINALIZED'].includes(r.state))throw new Error(`PIPELINE_DELIVERY_RECOVERY_REQUIRED:${r.state}`);
      if(r.state==='MINED'||r.state==='FINALIZED'){
        this.accepted(e,seq);
      }
      return this.result(e,r.state as PipelineResult['state'],r.reason,seq,r);
    });
  }
  async process(result:PollResult):Promise<PipelineResult>{
    if(!this.started||this.closed)throw new Error('PIPELINE_START_REQUIRED');
    const e=this.entries.get(result.worker);if(!e)throw new Error('UNKNOWN_PIPELINE_WORKER');
    if(this.busy.has(result.worker))throw new Error('PIPELINE_WORKER_BUSY');this.busy.add(result.worker);
    try{
      // Observe receipts even during a source outage; never allocate past unresolved delivery.
      let recovered:PipelineResult|undefined;
      await this.serialized(async()=>{
        this.relay.renew();
        for(const seq of [...e.watch]){
          const r=await this.relay.reconcile(e.config,seq);
          if(r.state==='ORPHANED'){e.watch=e.watch.filter(v=>v!==seq);e.pending.push(seq);e.pending.sort((a,b)=>a<b?-1:a>b?1:0);}
        }
        const seq=e.pending[0];
        if(seq!==undefined&&this.relay.get(e.domain,seq)?.txHash){
          const r=await this.relay.reconcile(e.config,seq);
          if(r.state==='MINED'||r.state==='FINALIZED'){
            this.accepted(e,seq);recovered=this.result(e,r.state,r.reason,seq,r);
          }
        }
      });
      if(result.inspection.status==='QUARANTINED')e.quarantined=result.inspection.reason??'SOURCE_QUARANTINED';
      if(e.quarantined)return this.result(e,'QUARANTINED',e.quarantined);
      const blocked=await this.lifecycleGate(e);if(blocked)return blocked;
      const checkedAt=this.now();
      if(recovered)return {...recovered,lifecycle:e.lifecycleView};
      const invalid=result.inspection.status==='INVALID_DEPTH',allowInvalid=invalid&&permitsInvalidDepth(e.rules);
      if(invalid&&!allowInvalid)return this.result(e,'SOURCE_UNAVAILABLE',`INVALID_DEPTH:${result.inspection.reason}`);
      const complete=!!result.book&&!!result.metadata&&!!result.event;
      const prepare=(seq:bigint)=>this.network.prepare(e.config,e.rules,
        {bookBody:result.book!.body,metadata:JSON.parse(result.metadata!.body),event:JSON.parse(result.event!.body),
          bookReceivedAtMs:result.book!.receivedAtMs,metadataReceivedAtMs:result.metadata!.receivedAtMs,eventReceivedAtMs:result.event!.receivedAtMs},
        seq,this.now(),this.policy.headroomMs);
      if(e.pending.length){
        const p=this.packets.get(e.domain,e.pending[0]!)!,seq=p.packet.observation.sequence;
        if(!this.relay.get(e.domain,seq)&&!sourceTime(p.packet.sourceMs.toString(),this.now(),null,this.policy.headroomMs).hasHeadroom)
          return await this.publish(e,p); // expire an unsent packet without signing or sending.
        if(allowInvalid&&p.packet.observation.impactBidWad>0n){
          if(this.relay.get(e.domain,seq))return this.result(e,'SOURCE_UNAVAILABLE','INVALID_TRANSITION_BLOCKED_BY_PENDING_DELIVERY',seq);
          if(!complete)return this.result(e,'SOURCE_UNAVAILABLE','INCOMPLETE_INVALID_EVIDENCE');
          // Validate fresh raw evidence before discarding an unsent valid candidate.
          try{prepare(seq);}catch(error){
            if(error instanceof Error&&/^(OBSERVATION_UNAVAILABLE:|INSUFFICIENT_PUBLICATION_HEADROOM)/.test(error.message))return this.result(e,'SOURCE_UNAVAILABLE',error.message);
            throw error;
          }
          this.packets.expire(e.domain,this.owner,e.fence,this.now(),seq,'SUPERSEDED_BY_FRESH_INVALID_DEPTH');
          e.pending=e.pending.filter(v=>v!==seq);
        }else{
          if(result.inspection.status!=='COLLECTING'&&!allowInvalid)return this.result(e,'SOURCE_UNAVAILABLE',result.inspection.reason??result.inspection.status);
          return await this.publish(e,p);
        }
      }
      if(this.network.chainId===10143n&&!this.relay.budgetAvailable())
        return this.result(e,'SOURCE_UNAVAILABLE','TESTNET_RELAY_BUDGET_EXHAUSTED');
      if((result.inspection.status!=='COLLECTING'&&!allowInvalid)||!complete)
        return this.result(e,'SOURCE_UNAVAILABLE',result.inspection.reason??result.inspection.status);
      // Recompute from retained raw bodies, rather than trusting cached diagnostic summaries.
      let p;
      try{p=this.packets.allocate(e.domain,this.owner,e.fence,this.now(),prepare);}
      catch(error){
        if(error instanceof Error&&/^(OBSERVATION_UNAVAILABLE:|INSUFFICIENT_PUBLICATION_HEADROOM)/.test(error.message))return this.result(e,'SOURCE_UNAVAILABLE',error.message);
        throw error;
      }
      e.pending.push(p.observation.sequence);
      return await this.publish(e,this.packets.get(e.domain,p.observation.sequence)!,checkedAt);
    }finally{this.busy.delete(result.worker);}
  }
  async run(signal:AbortSignal,onResult:(result:PipelineResult)=>void|Promise<void>):Promise<void>{
    if(this.running||this.closed)throw new Error('PIPELINE_ALREADY_RUNNING_OR_CLOSED');
    if(!this.started)await this.start();this.running=true;
    const stop=new AbortController(),forward=()=>stop.abort();signal.addEventListener('abort',forward,{once:true});
    if(signal.aborted)forward();let failure:unknown;
    const heartbeat=setInterval(()=>{try{this.renew();}catch(error){failure=error;stop.abort();}},Math.max(1,Number(this.policy.leaseMs/3n)));
    try{
      const scheduled:ScheduledWorker[]=[...this.entries.values()].map(e=>e.lifecycle?{
        config:e.config,poll:()=>e.worker.poll(),shouldPoll:async()=>{
          await this.lifecycleGate(e);return e.lifecycleView?.mode!=='STOPPED';
        },
      }:e.worker);
      await new CollectionService(scheduled).run(stop.signal,async result=>{
        if(!stop.signal.aborted)await onResult(await this.process(result));
      });
      if(failure)throw failure;
    }finally{clearInterval(heartbeat);signal.removeEventListener('abort',forward);this.running=false;this.close();}
  }
  private release():void {
    for(const e of this.entries.values())if(e.fence){this.packets.release(e.domain,this.owner,e.fence);e.fence=0n;}
    this.relay.release();
    if(this.network.chainId===10143n)for(const e of this.entries.values()){
      e.lifecycle?.releaseLease?.();e.worker.releaseLease?.();
    }
    this.started=false;
  }
  close():void {
    if(this.closed)return;
    if(this.running||this.busy.size)throw new Error('PIPELINE_STILL_RUNNING');
    this.release();this.closed=true;
  }
}
