import { randomUUID } from 'node:crypto';
import { parseConfig, verifyListing, type MarketConfig } from './config.js';
import { json } from './math.js';
import { PacketStore, packetNamespace, type PacketDomain, type StoredPacket } from './packet-store.js';
import { prepareObservation, signPrepared, type RawSigner } from './publication.js';
import { parseRules, rulesHash, type RulesManifest } from './rules.js';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy, type DeliveryRecord } from './local-relay.js';
import { CollectionService, type ScheduledWorker } from './service.js';
import type { PollResult } from './worker.js';
import { sourceTime } from './time.js';

export type RecoverableSigner=RawSigner&{reconcile(owner:string,fence:bigint,chain:{lastSequence:bigint;lastObservedAt:bigint}):void};
export type PipelineWorker={worker:ScheduledWorker&{config:MarketConfig};rules:RulesManifest;signer:RecoverableSigner};
type Entry=PipelineWorker&{config:MarketConfig;domain:PacketDomain;fence:bigint;pending:bigint[];watch:bigint[]};
export type PipelineResult={worker:string;state:'SOURCE_UNAVAILABLE'|'EXPIRED'|'UNKNOWN'|'MINED'|'FINALIZED';
  reason:string|null;sequence:bigint|null;transactionHash:string|null;depthValid:boolean|null};

/** First joined development path: disabled configs, public test signer, chain 31337.
 * Stores are caller-owned. Operational admission and invalid-transition policy stay closed. */
export class LocalPipeline {
  private readonly owner=randomUUID();
  private readonly entries=new Map<string,Entry>();
  private readonly busy=new Set<string>();
  private tail:Promise<unknown>=Promise.resolve();
  private started=false;
  private running=false;
  private starting=false;
  private closed=false;
  constructor(workers:readonly PipelineWorker[],private readonly packets:PacketStore,private readonly relay:LocalRelay,
    private readonly transport:LocalRelayTransport,private readonly policy:RelayPolicy,
    private readonly now:()=>bigint=()=>BigInt(Date.now())){
    if(workers.length===0||workers.length>100)throw new Error('BAD_PIPELINE_WORKERS');
    if(policy.leaseMs>3600000n)throw new Error('BAD_PIPELINE_LEASE');
    const domains=new Set<string>();
    for(const input of workers){
      const config=parseConfig(JSON.parse(json(input.worker.config))),d=config.destination,rules=parseRules(input.rules);
      if(config.enabled||!d||d.chainId!=='31337')throw new Error('LOCAL_DISABLED_CONFIG_ONLY');
      if(input.signer.address.toLowerCase()!==d.signerAddress.toLowerCase()||rulesHash(rules)!==d.sourceRulesHash.toLowerCase())throw new Error('PIPELINE_RULES_OR_SIGNER_MISMATCH');
      const domain:PacketDomain={chainId:31337n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
      const ns=packetNamespace(domain);
      if(this.entries.has(config.key)||domains.has(ns))throw new Error('DUPLICATE_PIPELINE_WORKER');domains.add(ns);
      this.entries.set(config.key,{...input,config,rules,domain,fence:0n,pending:[],watch:[]});
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
    if(i.chainId!==31337n||i.engineCodeHash.toLowerCase()!==d.engineCodeHash.toLowerCase()
      ||i.abiHash.toLowerCase()!==d.abiHash.toLowerCase()||i.signer.toLowerCase()!==d.signerAddress.toLowerCase()
      ||i.rulesHash.toLowerCase()!==d.sourceRulesHash.toLowerCase())throw new Error('PIPELINE_IDENTITY_MISMATCH');
    verifyListing(e.config,i.listing);return i;
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
          if(p.state==='EXPIRED')continue;
          const seq=p.packet.observation.sequence,r=this.relay.get(e.domain,seq);
          if(r?.state==='QUARANTINED'||r?.state==='PREPARING'||r?.state==='REVERTED')throw new Error('PIPELINE_DELIVERY_RECOVERY_REQUIRED');
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
    return {worker:e.config.key,state,reason,sequence,transactionHash:r?.txHash??null,depthValid:r?.accepted?.depthValid??null};
  }
  private async publish(e:Entry,p:StoredPacket):Promise<PipelineResult>{
    const seq=p.packet.observation.sequence;
    if(!this.relay.get(e.domain,seq)&&!sourceTime(p.packet.sourceMs.toString(),this.now(),null,this.policy.headroomMs).hasHeadroom){
      this.packets.expire(e.domain,this.owner,e.fence,this.now(),seq,'UNSENT_HEADROOM_EXPIRED');
      e.pending=e.pending.filter(v=>v!==seq);return this.result(e,'EXPIRED','UNSENT_HEADROOM_EXPIRED',seq);
    }
    if(p.state!=='SIGNED')p=await this.bounded(signPrepared(this.packets,e.domain,this.owner,e.fence,seq,e.signer,this.now,this.policy.headroomMs));
    if(p.state==='EXPIRED'){e.pending=e.pending.filter(v=>v!==seq);return this.result(e,'EXPIRED',p.reason,seq);}
    return this.serialized(async()=>{
      this.relay.renew();let r=this.relay.get(e.domain,seq);
      if(r?.txHash)r=await this.relay.reconcile(e.config,seq);
      if(!r||!['MINED','FINALIZED'].includes(r.state))r=await this.relay.deliver(e.config,this.owner,e.fence,seq);
      if(r.state==='UNKNOWN')r=await this.relay.reconcile(e.config,seq);
      if(!['UNKNOWN','MINED','FINALIZED'].includes(r.state))throw new Error(`PIPELINE_DELIVERY_RECOVERY_REQUIRED:${r.state}`);
      if(r.state==='MINED'||r.state==='FINALIZED'){
        e.pending=e.pending.filter(v=>v!==seq);e.watch.push(seq);
        e.watch=e.watch.filter(v=>this.relay.get(e.domain,v)?.state!=='FINALIZED'||v===seq);
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
      await this.serialized(async()=>{
        this.relay.renew();
        for(const seq of [...e.watch]){
          const r=await this.relay.reconcile(e.config,seq);
          if(r.state==='ORPHANED'){e.watch=e.watch.filter(v=>v!==seq);e.pending.push(seq);e.pending.sort((a,b)=>a<b?-1:a>b?1:0);}
        }
      });
      if(result.inspection.status==='QUARANTINED')throw new Error(`PIPELINE_SOURCE_QUARANTINED:${result.inspection.reason}`);
      if(e.pending.length)return await this.publish(e,this.packets.get(e.domain,e.pending[0]!)!);
      if(result.inspection.status!=='COLLECTING'||!result.book||!result.metadata||!result.event)
        return this.result(e,'SOURCE_UNAVAILABLE',result.inspection.reason??result.inspection.status);
      // Recompute from retained raw bodies, rather than trusting cached diagnostic summaries.
      const evidence={bookBody:result.book.body,metadata:JSON.parse(result.metadata.body),event:JSON.parse(result.event.body),
        bookReceivedAtMs:result.book.receivedAtMs,metadataReceivedAtMs:result.metadata.receivedAtMs,eventReceivedAtMs:result.event.receivedAtMs};
      let p;
      try{p=this.packets.allocate(e.domain,this.owner,e.fence,this.now(),seq=>prepareObservation(e.config,e.rules,evidence,seq,this.now(),this.policy.headroomMs));}
      catch(error){
        if(error instanceof Error&&/^(OBSERVATION_UNAVAILABLE:|INSUFFICIENT_PUBLICATION_HEADROOM)/.test(error.message))return this.result(e,'SOURCE_UNAVAILABLE',error.message);
        throw error;
      }
      e.pending.push(p.observation.sequence);
      return await this.publish(e,this.packets.get(e.domain,p.observation.sequence)!);
    }finally{this.busy.delete(result.worker);}
  }
  async run(signal:AbortSignal,onResult:(result:PipelineResult)=>void|Promise<void>):Promise<void>{
    if(this.running||this.closed)throw new Error('PIPELINE_ALREADY_RUNNING_OR_CLOSED');
    if(!this.started)await this.start();this.running=true;
    const stop=new AbortController(),forward=()=>stop.abort();signal.addEventListener('abort',forward,{once:true});
    if(signal.aborted)forward();let failure:unknown;
    const heartbeat=setInterval(()=>{try{this.renew();}catch(error){failure=error;stop.abort();}},Math.max(1,Number(this.policy.leaseMs/3n)));
    try{
      await new CollectionService([...this.entries.values()].map(e=>e.worker)).run(stop.signal,async result=>{
        if(!stop.signal.aborted)await onResult(await this.process(result));
      });
      if(failure)throw failure;
    }finally{clearInterval(heartbeat);signal.removeEventListener('abort',forward);this.running=false;this.close();}
  }
  private release():void {
    for(const e of this.entries.values())if(e.fence){this.packets.release(e.domain,this.owner,e.fence);e.fence=0n;}
    this.relay.release();this.started=false;
  }
  close():void {
    if(this.closed)return;
    if(this.running||this.busy.size)throw new Error('PIPELINE_STILL_RUNNING');
    this.release();this.closed=true;
  }
}
