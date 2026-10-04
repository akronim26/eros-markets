import { createHash } from 'node:crypto';
import { parseConfig, type MarketConfig } from './config.js';
import { Journal } from './journal.js';
import { json, UINT64_MAX } from './math.js';
import { workerNamespace } from './worker.js';

export type LifecycleMode='COLLECTING'|'RECORD_ONLY'|'DEGRADED'|'QUARANTINED'|'STOPPED';
/** A reader must read the pinned engine at this named block and verify its canonical hash.
 * Venue closure, oracle proposals and monitor reduce-only flags are not engine halts. */
export type LifecycleCheckpoint={chainId:bigint;engine:string;marketId:string;sourceId:string;
  engineCodeHash:string;rulesHash:string;scheduledT:bigint;halted:boolean;
  blockNumber:bigint;blockHash:string;blockTimestamp:bigint;canonical:boolean;
  sourceState?:{lastSequence:bigint;lastObservedAt:bigint}};
export type LifecycleView={mode:LifecycleMode;reason:string|null;atMs:bigint;
  checkpoint:LifecycleCheckpoint|null;freshCheckpoint:boolean};
export type LifecycleReader=()=>Promise<LifecycleCheckpoint>;

function checkedConfig(config:MarketConfig,chainId:bigint):MarketConfig {
  const cfg=parseConfig(JSON.parse(json(config))),d=cfg.destination;
  if(cfg.enabled||!d||d.chainId!==chainId.toString())
    throw new Error(chainId===31337n?'LOCAL_DISABLED_CONFIG_ONLY':'MONAD_DISABLED_TESTNET_CONFIG_REQUIRED');
  if(cfg.requiredFeedUntil===null||BigInt(cfg.requiredFeedUntil)<BigInt(d.scheduledT)
    ||BigInt(d.scheduledT)<BigInt(d.listedAt)+86400n
    ||BigInt(d.scheduledT)+BigInt(d.invalidRule.captureGraceSecs)>BigInt(d.listedAt)+BigInt(d.invalidRule.voidSecs))
    throw new Error('BAD_LIFECYCLE_HORIZON');
  return cfg;
}
export function validateMonadLifecycleConfig(config:MarketConfig):MarketConfig {return checkedConfig(config,10143n);}

/** Shared persistence/transition logic. Network selection is fixed by the wrappers below. */
class DurableLifecycle {
  readonly namespace:string;
  private readonly config:MarketConfig;
  private readonly digest:string;
  private view:LifecycleView;
  private current:Promise<LifecycleView>|null=null;
  private ownedFence:bigint|null=null;
  constructor(config:MarketConfig,private readonly journal:Journal,private readonly owner:string,
    private readonly read:LifecycleReader,private readonly maxCheckpointAgeMs:bigint,
    private readonly now:()=>bigint,private readonly chainId:bigint){
    this.config=checkedConfig(config,chainId);
    if(!owner||maxCheckpointAgeMs<1000n||maxCheckpointAgeMs>30000n)throw new Error('BAD_LIFECYCLE_POLICY');
    this.namespace=`lifecycle:${workerNamespace(this.config)}`;
    this.digest=createHash('sha256').update(json(this.config)).digest('hex');
    if(!journal.verify())throw new Error('LIFECYCLE_ARCHIVE_CORRUPT');
    this.view={mode:'DEGRADED',reason:'LIFECYCLE_SYNC_REQUIRED',atMs:this.now(),checkpoint:null,freshCheckpoint:false};
    const prior=journal.latest(this.namespace)?.payload;
    if(prior){
      if(prior.recordType!=='LIFECYCLE'||prior.schemaVersion!=='1'||prior.configDigest!==this.digest)throw new Error('LIFECYCLE_CONFIG_CHANGED');
      if(prior.maxCheckpointAgeMs!==maxCheckpointAgeMs.toString())throw new Error('LIFECYCLE_POLICY_CHANGED');
      const modes:LifecycleMode[]=['COLLECTING','RECORD_ONLY','DEGRADED','QUARANTINED','STOPPED'];
      if(!modes.includes(prior.mode as LifecycleMode)||typeof prior.atMs!=='string'
        ||!(prior.reason===null||typeof prior.reason==='string'))throw new Error('LIFECYCLE_ARCHIVE_CORRUPT');
      this.view={mode:prior.mode as LifecycleMode,reason:prior.reason,atMs:BigInt(prior.atMs),
        checkpoint:prior.checkpoint===null?null:this.decode(prior.checkpoint),freshCheckpoint:false};
    }
  }
  assertConfig(config:MarketConfig):void {
    if(createHash('sha256').update(json(parseConfig(JSON.parse(json(config))))).digest('hex')!==this.digest)
      throw new Error('LIFECYCLE_CONFIG_MISMATCH');
  }
  private decode(value:unknown):LifecycleCheckpoint {
    if(!value||typeof value!=='object')throw new Error('LIFECYCLE_BAD_CHECKPOINT');
    const v=value as Record<string,unknown>;
    const integer=(key:string,from=v)=>{
      const raw=from[key];
      if(!(typeof raw==='bigint'||typeof raw==='string'&&/^\d{1,20}$/.test(raw)))throw new Error('LIFECYCLE_BAD_CHECKPOINT');
      const n=BigInt(raw);if(n<0n||n>UINT64_MAX)throw new Error('LIFECYCLE_BAD_CHECKPOINT');return n;
    };
    const text=(key:string)=>{if(typeof v[key]!=='string')throw new Error('LIFECYCLE_BAD_CHECKPOINT');return v[key];};
    if(typeof v.halted!=='boolean'||typeof v.canonical!=='boolean')throw new Error('LIFECYCLE_BAD_CHECKPOINT');
    const c:LifecycleCheckpoint={chainId:integer('chainId'),engine:text('engine'),marketId:text('marketId'),
      sourceId:text('sourceId'),engineCodeHash:text('engineCodeHash'),rulesHash:text('rulesHash'),
      scheduledT:integer('scheduledT'),halted:v.halted,blockNumber:integer('blockNumber'),
      blockHash:text('blockHash'),blockTimestamp:integer('blockTimestamp'),canonical:v.canonical};
    const d=this.config.destination!;
    if(c.chainId!==this.chainId||c.engine.toLowerCase()!==d.engineAddress.toLowerCase()
      ||c.marketId.toLowerCase()!==d.marketId.toLowerCase()||c.sourceId.toLowerCase()!==d.sourceId.toLowerCase()
      ||c.engineCodeHash.toLowerCase()!==d.engineCodeHash.toLowerCase()||c.rulesHash.toLowerCase()!==d.sourceRulesHash.toLowerCase()
      ||c.scheduledT!==BigInt(d.scheduledT))throw new Error('LIFECYCLE_PIN_MISMATCH');
    if(!/^0x[0-9a-fA-F]{64}$/.test(c.blockHash)||/^0x0{64}$/.test(c.blockHash))throw new Error('LIFECYCLE_BAD_CHECKPOINT');
    if(this.chainId===10143n){
      if(!v.sourceState||typeof v.sourceState!=='object'||Array.isArray(v.sourceState))throw new Error('LIFECYCLE_BAD_CHECKPOINT');
      const s=v.sourceState as Record<string,unknown>;
      c.sourceState={lastSequence:integer('lastSequence',s),lastObservedAt:integer('lastObservedAt',s)};
      if(c.sourceState.lastObservedAt>c.blockTimestamp||(c.sourceState.lastSequence===0n&&c.sourceState.lastObservedAt!==0n))
        throw new Error('LIFECYCLE_BAD_CHECKPOINT');
    }
    return c;
  }
  check():Promise<LifecycleView>{
    if(this.current)return this.current;
    const op=this.checkOnce();this.current=op;
    void op.finally(()=>{if(this.current===op)this.current=null;}).catch(()=>{});return op;
  }
  releaseLease():boolean {
    if(this.current)throw new Error('LIFECYCLE_CHECK_RUNNING');
    if(this.ownedFence===null)return false;
    const released=this.journal.release(this.namespace,this.owner,this.ownedFence);this.ownedFence=null;return released;
  }
  private async checkOnce():Promise<LifecycleView>{
    if(this.view.mode==='STOPPED'||this.view.mode==='QUARANTINED')return structuredClone({...this.view,freshCheckpoint:false});
    const fence=this.journal.acquire(this.namespace,this.owner,this.now(),60000n);
    this.ownedFence=fence;
    let checkpoint=this.view.checkpoint,mode:LifecycleMode,reason:string|null=null,freshCheckpoint=false;
    try{
      const c=this.decode(await this.read()),at=this.now(),previous=checkpoint;
      if(!c.canonical)throw new Error('LIFECYCLE_REORG');
      if(previous&&(c.blockNumber<previous.blockNumber||c.blockTimestamp<previous.blockTimestamp))throw new Error('LIFECYCLE_BLOCK_REGRESSION');
      if(previous&&c.blockNumber===previous.blockNumber&&c.blockHash.toLowerCase()!==previous.blockHash.toLowerCase())throw new Error('LIFECYCLE_REORG');
      if(previous&&c.blockNumber===previous.blockNumber&&(c.blockTimestamp!==previous.blockTimestamp||c.halted!==previous.halted))throw new Error('LIFECYCLE_BLOCK_CHANGED');
      if(previous&&c.blockNumber>previous.blockNumber&&c.blockHash.toLowerCase()===previous.blockHash.toLowerCase())throw new Error('LIFECYCLE_BLOCK_CHANGED');
      if(previous?.halted&&!c.halted)throw new Error('LIFECYCLE_HALT_REGRESSION');
      if(previous?.sourceState&&c.sourceState){
        const old=previous.sourceState,next=c.sourceState;
        if(next.lastSequence<old.lastSequence||next.lastObservedAt<old.lastObservedAt)throw new Error('LIFECYCLE_SOURCE_REGRESSION');
        if((c.blockNumber===previous.blockNumber&&(next.lastSequence!==old.lastSequence||next.lastObservedAt!==old.lastObservedAt))
          ||(next.lastSequence===old.lastSequence&&next.lastObservedAt!==old.lastObservedAt))throw new Error('LIFECYCLE_SOURCE_CHANGED');
      }
      if(c.blockTimestamp>at/1000n||at-c.blockTimestamp*1000n>this.maxCheckpointAgeMs)throw new Error('LIFECYCLE_CLOCK_OR_STALE_BLOCK');
      checkpoint=c;freshCheckpoint=true;
      // Include the deadline itself; only a verified block beyond it stops collection.
      if(c.blockTimestamp>BigInt(this.config.requiredFeedUntil!)){mode='STOPPED';reason='RECORDING_DEADLINE_PASSED';}
      else if(c.halted||c.blockTimestamp>=c.scheduledT){mode='RECORD_ONLY';reason=c.halted?'ENGINE_HALTED':'SCHEDULED_T_REACHED';}
      else mode='COLLECTING';
    }catch(error){
      reason=error instanceof Error?error.message:String(error);
      mode=/^LIFECYCLE_(PIN_MISMATCH|BAD_CHECKPOINT|REORG|BLOCK_REGRESSION|BLOCK_CHANGED|HALT_REGRESSION|SOURCE_REGRESSION|SOURCE_CHANGED)$/.test(reason)?'QUARANTINED':'DEGRADED';
    }
    const next={mode,reason,atMs:this.now(),checkpoint,freshCheckpoint};
    // Store before returning permission to collect/sign. Storage/fencing errors propagate.
    this.journal.append(this.namespace,this.owner,fence,this.now(),{recordType:'LIFECYCLE',schemaVersion:'1',configDigest:this.digest,
      worker:this.config.key,category:this.config.category,maxCheckpointAgeMs:this.maxCheckpointAgeMs,...next});
    this.view=next;return structuredClone(next);
  }
}

/** Existing development publication gate: still fixed to disabled local-chain configs. */
export class LocalLifecycle extends DurableLifecycle {
  constructor(config:MarketConfig,journal:Journal,owner:string,read:LifecycleReader,maxCheckpointAgeMs:bigint,
    now:()=>bigint=()=>BigInt(Date.now())){
    super(config,journal,owner,read,maxCheckpointAgeMs,now,31337n);
  }
}

/** Diagnostic monitor only. It has no signing or sending capabilities. */
export class MonadTestnetLifecycleMonitor extends DurableLifecycle {
  readonly readOnly=true;
  constructor(config:MarketConfig,journal:Journal,owner:string,read:LifecycleReader,maxCheckpointAgeMs:bigint,
    now:()=>bigint=()=>BigInt(Date.now())){
    super(config,journal,owner,read,maxCheckpointAgeMs,now,10143n);
  }
}

/** Fixed testnet publication boundary controller; operational admission remains closed. */
export class MonadTestnetPublicationLifecycle extends DurableLifecycle {
  constructor(config:MarketConfig,journal:Journal,owner:string,read:LifecycleReader,maxCheckpointAgeMs:bigint,
    now:()=>bigint=()=>BigInt(Date.now())){
    super(config,journal,owner,read,maxCheckpointAgeMs,now,10143n);
  }
}
