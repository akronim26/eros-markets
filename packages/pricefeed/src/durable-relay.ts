import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { verifyListing, type MarketConfig } from './config.js';
import { json } from './math.js';
import { PacketStore, packetNamespace, type PacketDomain, type StoredPacket } from './packet-store.js';
import { confirmationState, validateReceipt, type AcceptedReceipt, type DeliveryReceipt } from './receipts.js';
import { sourceTime } from './time.js';
import { submitCalldata } from './wire.js';
import { sizeGas, type GasSizing } from './gas.js';
import { relayProfileBody, verifyBudgetAudit, type RelayProfile } from './relay-policy.js';
import { nonceRecoveries, recoveryBudget, validateCancellationReceipt, verifyCancellationSigner } from './nonce-recovery-journal.js';
import { canonicalTransactionRequest, parseTransactionRequest, type RelayTransactionRequest, type TransactionJournal } from './local-transaction-signer.js';
import { verifyHistoryRecoveryAudit } from './history-recovery-journal.js';

export type LocalRelayTransport={
  rpcUrl:string;sender:string;finalizedHead?:true;
  transactionJournal?:TransactionJournal;
  pendingNonce():Promise<bigint>;
  identity(domain:PacketDomain):Promise<{chainId:bigint;engineCodeHash:string;abiHash:string;listing:Record<string,unknown>;
    signer:string;rulesHash:string;lastSequence:bigint;lastObservedAt:bigint}>;
  simulate(to:string,data:Hex,gasLimit?:bigint):Promise<void|GasSizing>;
  // Must sign without sending; repeated nonce/data requests must preserve identity.
  prepare(request:RelayTransactionRequest):Promise<Hex>;
  broadcast(raw:Hex):Promise<Hex>;
  receipt(hash:Hex):Promise<DeliveryReceipt|null>;
  block(number:bigint):Promise<{number:bigint;hash:Hex;timestamp:bigint}|null>;
  head():Promise<bigint>;
};
export type RelayPolicy={gasCap:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint;maxCostWei:bigint;
  headroomMs:bigint;confirmations:bigint;timeoutMs:number;maxAttempts:number;leaseMs:bigint;gasSafetyMarginBps?:bigint};
export type DeliveryState='PREPARING'|'READY'|'UNKNOWN'|'MINED'|'FINALIZED'|'ORPHANED'|'REVERTED'|'QUARANTINED'|'CANCELLED';
export type DeliveryRecord={namespace:string;sequence:bigint;digest:Hex;nonce:bigint;raw:Hex|null;txHash:Hex|null;
  request?:RelayTransactionRequest;
  gasSizing?:GasSizing;
  state:DeliveryState;attempts:number;accepted:AcceptedReceipt|null;reason:string|null};
const checksum=(body:string)=>createHash('sha256').update(body).digest('hex');
/** Shared durable relay mechanics. Fixed-network wrappers determine endpoint and finality admission. */
export class DurableRelay {
  private readonly db:DatabaseSync;
  private readonly owner=randomUUID();
  private fence=0n;
  private ready=false;
  private active=false;
  private readonly profileBody:string;
  protected constructor(path:string,private readonly packets:PacketStore,private readonly transport:LocalRelayTransport,
    private readonly policy:RelayPolicy,private readonly now:()=>bigint,
    private readonly profile:RelayProfile){
    const url=new URL(transport.rpcUrl);
    if(profile.chainId===31337n){
      if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.hash)throw new Error('LOCAL_RPC_ONLY');
    }else if(url.protocol!=='https:'||url.username||url.password||url.hash||!transport.finalizedHead||!transport.transactionJournal
      ||policy.confirmations!==1n||!Number.isSafeInteger(profile.maxTransactions)||profile.maxTransactions!<1
      ||profile.maxTransactions!>100000||typeof profile.totalMaxCostWei!=='bigint'||profile.totalMaxCostWei<policy.maxCostWei)
      throw new Error('BAD_MONAD_TESTNET_RELAY_PROFILE');
    if(!isAddress(transport.sender)||policy.gasCap<=0n||policy.maxFeePerGas<=0n||policy.maxPriorityFeePerGas<0n
      ||policy.maxPriorityFeePerGas>policy.maxFeePerGas||policy.maxCostWei<policy.gasCap*policy.maxFeePerGas
      ||policy.headroomMs<=0n||policy.headroomMs>30000n||policy.confirmations<=0n
      ||!Number.isSafeInteger(policy.timeoutMs)||policy.timeoutMs<1||policy.timeoutMs>30000
      ||!Number.isSafeInteger(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>10
      ||policy.leaseMs<BigInt(policy.timeoutMs)*8n
      ||policy.gasSafetyMarginBps!==undefined&&(profile.chainId!==10143n||policy.gasSafetyMarginBps<100n||policy.gasSafetyMarginBps>5000n))throw new Error('BAD_RELAY_POLICY');
    this.db=new DatabaseSync(path,{timeout:1000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS relay_nonce(sender TEXT PRIMARY KEY,initial_nonce TEXT NOT NULL,next_nonce TEXT NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,until_ms TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS relay_signer(sender TEXT PRIMARY KEY,journal_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS relay_control(id INTEGER PRIMARY KEY CHECK(id=1),profile TEXT NOT NULL,reason TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries(key TEXT PRIMARY KEY,ns TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,body TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;`);
    this.profileBody=relayProfileBody(profile,policy);
    const profileBody=this.profileBody,control=this.db.prepare('SELECT profile,reason FROM relay_control WHERE id=1').get();
    if(control&&control.profile!==profileBody){this.db.close();throw new Error('RELAY_PROFILE_CHANGED');}
    if(!control)this.db.prepare('INSERT INTO relay_control VALUES(1,?,NULL)').run(profileBody);
    try{verifyBudgetAudit(this.db,profileBody,profile.budgetRevision??0);verifyHistoryRecoveryAudit(this.db,transport.sender);}
    catch(error){this.db.close();throw error;}
    const accounts=this.db.prepare('SELECT sender,initial_nonce,next_nonce FROM relay_nonce').all();
    const signerPins=this.db.prepare('SELECT sender FROM relay_signer').all();
    if(signerPins.length>1||signerPins.some(r=>r.sender!==transport.sender.toLowerCase())){this.db.close();throw new Error('RELAY_ACCOUNT_CHANGED');}
    if(accounts.length>1||accounts.some(r=>r.sender!==transport.sender.toLowerCase())){this.db.close();throw new Error('RELAY_ACCOUNT_CHANGED');}
    try{for(const r of this.db.prepare('SELECT * FROM deliveries').all())this.parse(String(r.body),String(r.sha256));nonceRecoveries(this.db);}
    catch(error){this.db.close();throw error;}
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private async bounded<T>(op:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([op,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('RELAY_TIMEOUT')),this.policy.timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private account(){const q=this.db.prepare('SELECT * FROM relay_nonce WHERE sender=?');q.setReadBigInts(true);return q.get(this.transport.sender.toLowerCase());}
  private lease():void {
    if(this.db.prepare('SELECT profile FROM relay_control WHERE id=1').get()?.profile!==this.profileBody)throw new Error('RELAY_PROFILE_CHANGED');
    const row=this.account();
    if(this.db.prepare('SELECT reason FROM relay_control WHERE id=1').get()?.reason)throw new Error('RELAY_PERSISTENT_QUARANTINE');
    if(!row||row.owner!==this.owner||BigInt(String(row.fence))!==this.fence||BigInt(String(row.until_ms))<=this.now())throw new Error('RELAY_WRITER_FENCED');
  }
  renew():void {
    if(!this.ready)throw new Error('RELAY_START_REQUIRED');
    this.tx(()=>{this.lease();this.db.prepare('UPDATE relay_nonce SET until_ms=? WHERE sender=? AND owner=? AND fence=?')
      .run((this.now()+this.policy.leaseMs).toString(),this.transport.sender.toLowerCase(),this.owner,this.fence);});
  }
  release():void {
    if(this.active)throw new Error('RELAY_BUSY');
    this.db.prepare("UPDATE relay_nonce SET until_ms='0' WHERE sender=? AND owner=? AND fence=?")
      .run(this.transport.sender.toLowerCase(),this.owner,this.fence);this.ready=false;
  }
  async start():Promise<void>{
    if(this.active)throw new Error('RELAY_BUSY');
    if(this.db.prepare('SELECT reason FROM relay_control WHERE id=1').get()?.reason)throw new Error('RELAY_PERSISTENT_QUARANTINE');
    this.ready=false;const nonce=await this.bounded(this.transport.pendingNonce());
    if(nonce<0n||nonce>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('BAD_RELAY_NONCE');
    this.tx(()=>{
      if(this.db.prepare('SELECT profile FROM relay_control WHERE id=1').get()?.profile!==this.profileBody)throw new Error('RELAY_PROFILE_CHANGED');
      const row=this.account(),now=this.now();
      if(row&&BigInt(String(row.until_ms))>now&&row.owner!==this.owner)throw new Error('RELAY_WRITER_BUSY');
      if(row&&(nonce>BigInt(String(row.next_nonce))||nonce<BigInt(String(row.initial_nonce))))throw new Error('UNKNOWN_RELAY_NONCE');
      if(row){
        const rows=this.db.prepare('SELECT nonce FROM deliveries').all();
        const next=rows.reduce((high,r)=>BigInt(String(r.nonce))>=high?BigInt(String(r.nonce))+1n:high,BigInt(String(row.initial_nonce)));
        if(next!==BigInt(String(row.next_nonce)))throw new Error('RELAY_NONCE_JOURNAL_INTEGRITY');
      }
      const signer=this.db.prepare('SELECT journal_id FROM relay_signer WHERE sender=?').get(this.transport.sender.toLowerCase());
      const journal=this.transport.transactionJournal;
      if(signer&&signer.journal_id!==journal?.id)throw new Error('RELAY_TRANSACTION_SIGNER_CHANGED');
      if(journal&&!signer){
        if(this.db.prepare('SELECT count(*) AS n FROM deliveries').get()!.n!==0)throw new Error('TRANSACTION_SIGNER_MIGRATION_REQUIRED');
        this.db.prepare('INSERT INTO relay_signer VALUES(?,?)').run(this.transport.sender.toLowerCase(),journal.id);
      }
      this.fence=row&&row.owner===this.owner&&BigInt(String(row.until_ms))>now?BigInt(String(row.fence)):BigInt(String(row?.fence??0))+1n;
      this.db.prepare('INSERT INTO relay_nonce VALUES(?,?,?,?,?,?) ON CONFLICT(sender) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,until_ms=excluded.until_ms')
        .run(this.transport.sender.toLowerCase(),nonce.toString(),nonce.toString(),this.owner,this.fence,(now+this.policy.leaseMs).toString());
    });this.ready=true;
    try{
      const journal=this.transport.transactionJournal;
      if(journal){
        const reservations=this.db.prepare('SELECT body,sha256 FROM deliveries').all().map(row=>{
          const r=this.parse(String(row.body),String(row.sha256));
          if(!r.request)throw new Error('TRANSACTION_REQUEST_JOURNAL_REQUIRED');return {request:r.request,raw:r.raw};
        });
        await this.bounded(journal.reconcile(reservations));this.lease();
      }
      for(const r of nonceRecoveries(this.db)){
        if(r.state!=='FINALIZED')throw new Error('RELAY_NONCE_RECOVERY_REQUIRED');
        await verifyCancellationSigner(r);
        const receipt=await this.bounded(this.transport.receipt(r.hash!));
        if(!receipt)throw new Error('NONCE_RECOVERY_RECEIPT_MISSING');
        validateCancellationReceipt(r,receipt);
        const block=await this.bounded(this.transport.block(receipt.blockNumber));
        if(!block||block.hash!==receipt.blockHash||receipt.blockNumber>await this.bounded(this.transport.head())
          ||json(receipt)!==json(r.receipt))throw new Error('NONCE_RECOVERY_CANONICAL_MISMATCH');
      }
    }catch(error){this.release();throw error;}
  }
  private key(d:PacketDomain,sequence:bigint):string{return `${packetNamespace(d)}:${sequence}`;}
  private parse(body:string,sha:string):DeliveryRecord {
    if(checksum(body)!==sha)throw new Error('DELIVERY_JOURNAL_INTEGRITY');
    const r=JSON.parse(body);
    if(r.gasSizing){
      const s=r.gasSizing;
      r.gasSizing={estimatedGas:BigInt(s.estimatedGas),gasLimit:BigInt(s.gasLimit),marginBps:BigInt(s.marginBps)};
      if(!r.request||r.gasSizing.gasLimit!==BigInt(r.request.gas)
        ||sizeGas(r.gasSizing.estimatedGas,BigInt(r.request.gas),r.gasSizing.marginBps).gasLimit!==r.gasSizing.gasLimit)
        throw new Error('DELIVERY_JOURNAL_INTEGRITY');
    }
    if(r.request&&parseTransactionRequest(r.request).nonce!==BigInt(r.nonce))throw new Error('DELIVERY_JOURNAL_INTEGRITY');
    return {...r,sequence:BigInt(r.sequence),nonce:BigInt(r.nonce),accepted:r.accepted?{...r.accepted,
      blockNumber:BigInt(r.accepted.blockNumber),acceptedAt:BigInt(r.accepted.acceptedAt),priceWad:BigInt(r.accepted.priceWad)}:null,
      ...(r.request?{request:parseTransactionRequest(r.request)}:{})} as DeliveryRecord;
  }
  get(d:PacketDomain,seq:bigint):DeliveryRecord|null {
    const r=this.db.prepare('SELECT * FROM deliveries WHERE key=?').get(this.key(d,seq));
    return r?this.parse(String(r.body),String(r.sha256)):null;
  }
  private save(d:PacketDomain,r:DeliveryRecord):void {
    this.tx(()=>{this.lease();const body=json(r);this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,sha256=excluded.sha256').run(this.key(d,r.sequence),r.namespace,r.nonce.toString(),body,checksum(body));});
  }
  private fresh(packet:StoredPacket):boolean {
    return this.now()/1000n>=packet.packet.observation.publishedAt&&sourceTime(packet.packet.sourceMs.toString(),this.now(),null,this.policy.headroomMs).hasHeadroom;
  }
  canResumePreparing(d:PacketDomain,seq:bigint):boolean {
    if(!this.ready)return false;this.lease();const r=this.get(d,seq);
    return !!this.transport.transactionJournal&&r?.state==='PREPARING'&&!!r.request&&r.raw===null;
  }
  budgetAvailable():boolean {
    if(this.profile.chainId===31337n)return true;
    const prior=this.db.prepare('SELECT body,sha256 FROM deliveries').all().map(row=>this.parse(String(row.body),String(row.sha256)));
    const total=prior.reduce((sum,r)=>sum+(r.request?r.request.gas*r.request.maxFeePerGas:this.policy.maxCostWei),0n);
    const recovery=recoveryBudget(this.db);
    return prior.length+recovery.count<this.profile.maxTransactions!&&total+recovery.reservedWei+this.policy.gasCap*this.policy.maxFeePerGas<=this.profile.totalMaxCostWei!;
  }
  async deliver(cfg:MarketConfig,owner:string,fence:bigint,seq:bigint,beforeSend?:()=>Promise<void>):Promise<DeliveryRecord>{
    if(this.active)throw new Error('RELAY_BUSY');this.active=true;
    try{
      if(!this.ready)throw new Error('RELAY_START_REQUIRED');this.lease();
      const dest=cfg.destination;if(cfg.enabled||!dest||dest.chainId!==this.profile.chainId.toString())throw new Error('LOCAL_DISABLED_CONFIG_ONLY');
      const d:PacketDomain={chainId:this.profile.chainId,engine:dest.engineAddress,marketId:dest.marketId,sourceId:dest.sourceId,rulesHash:dest.sourceRulesHash,signer:dest.signerAddress};
      this.packets.assertWriter(d,owner,fence,this.now());
      const packet=this.packets.get(d,seq);if(!packet?.signature||packet.state!=='SIGNED')throw new Error('SIGNED_PACKET_REQUIRED');
      const ns=packetNamespace(d);let r=this.get(d,seq);
      if(r&&['UNKNOWN','ORPHANED','MINED','FINALIZED'].includes(r.state))r=await this.reconcileDelivery(cfg,seq);
      if(r&&['MINED','FINALIZED','REVERTED'].includes(r.state))return r;
      const data=submitCalldata(packet.packet.observation,packet.signature);
      // These reads are independent. Settle both before evaluating them in the
      // original identity/sequence/freshness/simulation order; neither may reserve
      // a nonce or sign, and retry recovery must still use the original hash.
      const [identityResult,simulationResult]=await Promise.allSettled([
        this.bounded(Promise.resolve().then(()=>this.transport.identity(d))),
        this.bounded(Promise.resolve().then(()=>this.transport.simulate(d.engine,data,r?.request?.gas))),
      ]);
      if(identityResult.status==='rejected')throw identityResult.reason;
      const identity=identityResult.value;
      if(identity.chainId!==this.profile.chainId||identity.engineCodeHash.toLowerCase()!==dest.engineCodeHash.toLowerCase()
        ||identity.abiHash.toLowerCase()!==dest.abiHash.toLowerCase()||identity.signer.toLowerCase()!==dest.signerAddress.toLowerCase()
        ||identity.rulesHash.toLowerCase()!==dest.sourceRulesHash.toLowerCase())throw new Error('RELAY_IDENTITY_MISMATCH');
      verifyListing(cfg,identity.listing);
      if(identity.lastSequence>=seq){
        // A prior UNKNOWN send may mine after the first receipt read. Only its
        // exact canonical receipt can establish acceptance; never reserve again.
        if(r?.txHash){
          r=await this.reconcileDelivery(cfg,seq);
          if(['MINED','FINALIZED','REVERTED'].includes(r.state))return r;
          if(r.state==='UNKNOWN')return r;
        }
        throw new Error('RECEIPT_RECONCILIATION_REQUIRED');
      }
      if(identity.lastObservedAt>packet.packet.observation.observedAt)throw new Error('BACKWARDS_CHAIN_SOURCE_TIME');
      const requireFresh=()=>{
        if(this.fresh(packet))return;
        // A restart or delayed read may exhaust a previously reserved nonce's
        // headroom. Persist account-wide recovery blocking, including reservations
        // without raw bytes; never leave them looking retryable after expiry.
        if(r&&['PREPARING','READY','UNKNOWN','ORPHANED'].includes(r.state))
          this.save(d,{...r,state:'QUARANTINED',reason:'RESERVED_NONCE_HEADROOM_EXPIRED'});
        throw new Error('RELAY_HEADROOM_EXPIRED');
      };
      requireFresh();
      if(r?.state==='QUARANTINED')throw new Error('RELAY_RECOVERY_REQUIRED');
      // A rejected simulation must not burn a shared-account nonce before signing.
      if(simulationResult.status==='rejected'){
        // Inclusion between identity and simulation makes a valid retry revert
        // as a duplicate. Reconcile the original hash, with all receipt checks.
        if(r?.txHash){
          r=await this.reconcileDelivery(cfg,seq);
          if(['MINED','FINALIZED','REVERTED'].includes(r.state))return r;
        }
        throw simulationResult.reason;
      }
      const sizing=simulationResult.value;
      if(this.policy.gasSafetyMarginBps!==undefined&&(!sizing||sizing.gasLimit>this.policy.gasCap
        ||sizing.estimatedGas<21000n||sizing.gasLimit<sizing.estimatedGas
        ||sizing.marginBps!==this.policy.gasSafetyMarginBps))throw new Error('MONAD_GAS_ESTIMATE_REQUIRED');
      const selectedGas=r?.request?.gas??sizing?.gasLimit??this.policy.gasCap;
      this.packets.assertWriter(d,owner,fence,this.now());
      requireFresh();
      // A slow simulation may cross the recording deadline. Check before reserving a nonce.
      if(beforeSend)await beforeSend();
      this.packets.assertWriter(d,owner,fence,this.now());
      requireFresh();
      if(!r){r=this.tx(()=>{
        this.lease();
        for(const row of this.db.prepare('SELECT body,sha256 FROM deliveries WHERE ns=?').all(ns)){
          const old=this.parse(String(row.body),String(row.sha256));
          if(!['MINED','FINALIZED','REVERTED','CANCELLED'].includes(old.state))throw new Error('OLDER_DELIVERY_UNRESOLVED');
        }
        // A quarantined reserved nonce anywhere blocks the shared relay account.
        for(const row of this.db.prepare('SELECT body,sha256 FROM deliveries').all())
          if(this.parse(String(row.body),String(row.sha256)).state==='QUARANTINED')throw new Error('RELAY_NONCE_RECOVERY_REQUIRED');
        if(this.profile.chainId===10143n){
          const prior=this.db.prepare('SELECT body,sha256 FROM deliveries').all().map(row=>this.parse(String(row.body),String(row.sha256)));
          const total=prior.reduce((sum,r)=>sum+(r.request?r.request.gas*r.request.maxFeePerGas:this.policy.maxCostWei),0n);
          const recovery=recoveryBudget(this.db);
          if(prior.length+recovery.count>=this.profile.maxTransactions!||total+recovery.reservedWei+selectedGas*this.policy.maxFeePerGas>this.profile.totalMaxCostWei!)
            throw new Error('TESTNET_RELAY_BUDGET_EXHAUSTED');
        }
        const account=this.account()!,nonce=BigInt(String(account.next_nonce));if(nonce>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('RELAY_NONCE_EXHAUSTED');
        const request=canonicalTransactionRequest({to:d.engine,data,nonce,gas:selectedGas,maxFeePerGas:this.policy.maxFeePerGas,maxPriorityFeePerGas:this.policy.maxPriorityFeePerGas});
        const next:DeliveryRecord={namespace:ns,sequence:seq,digest:packet.digest,nonce,request,...(sizing?{gasSizing:sizing}:{}),raw:null,txHash:null,state:'PREPARING',attempts:0,accepted:null,reason:null};
        const body=json(next);this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?)').run(this.key(d,seq),ns,nonce.toString(),body,checksum(body));
        this.db.prepare('UPDATE relay_nonce SET next_nonce=? WHERE sender=?').run((nonce+1n).toString(),this.transport.sender.toLowerCase());return next;
      });}
      if(r.digest!==packet.digest)throw new Error('DELIVERY_PACKET_MISMATCH');
      const request=r.request??{to:d.engine,data,nonce:r.nonce,gas:this.policy.gasCap,maxFeePerGas:this.policy.maxFeePerGas,maxPriorityFeePerGas:this.policy.maxPriorityFeePerGas};
      if(request.to.toLowerCase()!==d.engine.toLowerCase()||request.data!==data||request.nonce!==r.nonce||request.gas>this.policy.gasCap
        ||request.maxFeePerGas>this.policy.maxFeePerGas||request.maxPriorityFeePerGas>this.policy.maxPriorityFeePerGas
        ||request.gas*request.maxFeePerGas>this.policy.maxCostWei)throw new Error('DELIVERY_TRANSACTION_REQUEST_MISMATCH');
      if(!r.raw){
        try{
          const raw=await this.bounded(this.transport.prepare(request));
          const tx=parseTransaction(raw);
          if(tx.type!=='eip1559'||tx.chainId!==Number(this.profile.chainId)||tx.nonce!==Number(r.nonce)||tx.to?.toLowerCase()!==d.engine.toLowerCase()
            ||tx.data?.toLowerCase()!==data.toLowerCase()||(tx.value??0n)!==0n||!tx.gas||tx.gas!==request.gas||tx.maxFeePerGas!==request.maxFeePerGas||tx.maxPriorityFeePerGas!==request.maxPriorityFeePerGas
            ||!tx.maxFeePerGas||tx.maxFeePerGas>this.policy.maxFeePerGas||(tx.maxPriorityFeePerGas??0n)>this.policy.maxPriorityFeePerGas
            ||tx.gas*tx.maxFeePerGas>this.policy.maxCostWei
            ||(await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase()!==this.transport.sender.toLowerCase())throw new Error('SIGNED_TRANSACTION_MISMATCH');
          r={...r,raw,txHash:keccak256(raw),state:'READY'};this.save(d,r);
        }catch(error){this.save(d,{...r,state:'QUARANTINED',reason:error instanceof Error?error.message:String(error)});throw error;}
      }
      this.packets.assertWriter(d,owner,fence,this.now());
      if(!this.fresh(packet)){this.save(d,{...r,state:'QUARANTINED',reason:'RESERVED_NONCE_HEADROOM_EXPIRED'});throw new Error('RELAY_HEADROOM_EXPIRED');}
      if(r.attempts>=this.policy.maxAttempts)throw new Error('RELAY_ATTEMPTS_EXHAUSTED');
      if(beforeSend){
        try{
          await beforeSend();
          this.packets.assertWriter(d,owner,fence,this.now());
          if(!this.fresh(packet))throw new Error('RELAY_HEADROOM_EXPIRED');
        }
        catch(error){
          // A reserved, signed nonce cannot be silently reused or skipped after a stop.
          this.save(d,{...r,state:'QUARANTINED',reason:error instanceof Error?error.message:String(error)});throw error;
        }
      }
      r={...r,state:'UNKNOWN',attempts:r.attempts+1,reason:'BROADCAST_RESULT_PENDING'};this.save(d,r); // before network I/O
      try{
        const returned=await this.bounded(this.transport.broadcast(r.raw!));
        if(returned.toLowerCase()!==r.txHash)throw new Error('BROADCAST_HASH_MISMATCH');
        r={...r,reason:null};this.save(d,r);
      }catch(error){r={...r,reason:error instanceof Error?error.message:String(error)};this.save(d,r);}
      return r; // UNKNOWN until a matching receipt, even if RPC returned a hash.
    }finally{this.active=false;}
  }
  async reconcile(cfg:MarketConfig,seq:bigint):Promise<DeliveryRecord>{
    if(this.active)throw new Error('RELAY_BUSY');this.active=true;
    try{return await this.reconcileDelivery(cfg,seq);}finally{this.active=false;}
  }
  private async reconcileDelivery(cfg:MarketConfig,seq:bigint):Promise<DeliveryRecord>{
    if(!this.ready)throw new Error('RELAY_START_REQUIRED');this.lease();
    const dest=cfg.destination;if(!dest||cfg.enabled||dest.chainId!==this.profile.chainId.toString())throw new Error('LOCAL_DISABLED_CONFIG_ONLY');
    const d:PacketDomain={chainId:this.profile.chainId,engine:dest.engineAddress,marketId:dest.marketId,sourceId:dest.sourceId,rulesHash:dest.sourceRulesHash,signer:dest.signerAddress};
    let r=this.get(d,seq);if(!r?.txHash)throw new Error('NO_SENT_TRANSACTION');
    const receipt=await this.bounded(this.transport.receipt(r.txHash));
    if(receipt){
      if(receipt.transactionHash.toLowerCase()!==r.txHash)throw new Error('RECEIPT_IDENTITY_MISMATCH');
      // The receipt's canonical block and finalized head are independent reads.
      // Settle both before inspecting them, preserving error priority and every
      // identity/finality check while avoiding a serial RPC round trip.
      const [blockRead,headRead]=await Promise.allSettled([
        this.bounded(this.transport.block(receipt.blockNumber)),this.bounded(this.transport.head()),
      ]);
      if(blockRead.status==='rejected')throw blockRead.reason;
      const block=blockRead.value;if(!block)return r;
      if(block.hash.toLowerCase()!==receipt.blockHash.toLowerCase())r={...r,state:'ORPHANED',reason:'NONCANONICAL_RECEIPT',accepted:null};
      else if(receipt.status==='reverted')r={...r,state:'REVERTED',reason:'TRANSACTION_REVERTED',accepted:null};
      else{
        const packet=this.packets.get(d,seq);if(!packet||packet.digest!==r.digest)throw new Error('DELIVERY_PACKET_MISMATCH');
        const accepted=validateReceipt(packet.packet,r.txHash,receipt,block,{depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad)});
        if(headRead.status==='rejected')throw headRead.reason;
        const state=confirmationState(accepted,block.hash,headRead.value,this.policy.confirmations);
        r={...r,state,accepted,reason:null};
      }
    }else if(r.accepted){
      const [block,head]=await Promise.all([
        this.bounded(this.transport.block(r.accepted.blockNumber)),this.bounded(this.transport.head()),
      ]);
      const state=confirmationState(r.accepted,block?.hash??null,head,this.policy.confirmations);
      if(state==='ORPHANED')r={...r,state,accepted:null,reason:'ORPHANED_ACCEPTANCE'};
      // Missing receipt cannot newly establish finality even with a canonical block hash.
    }
    this.save(d,r);return r;
  }
  quarantine(reason:string):void {
    if(this.profile.chainId!==10143n||!reason||reason.length>100)throw new Error('BAD_RELAY_QUARANTINE');
    this.db.prepare('UPDATE relay_control SET reason=? WHERE id=1').run(reason);
  }
  close():void{this.db.close();}
}
