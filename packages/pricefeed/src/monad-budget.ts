import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { parseConfig, type MarketConfig } from './config.js';
import { validateMonadLifecycleConfig } from './lifecycle.js';
import { PacketStore, packetNamespace, type PacketDomain, type PreparedPacket } from './packet-store.js';
import { Journal } from './journal.js';
import { parseTransactionRequest } from './durable-transaction-signer.js';
import { parseEngineReadAbi, preflightMonadTestnet } from './monad-preflight.js';
import { monadSubmissionRpc, type MonadSubmissionRpc } from './monad-rpc.js';
import { parseTestnetRunPolicy, type TestnetRunPolicy } from './monad-service.js';
import { policyHash, relayProfileBody, verifyBudgetAudit } from './relay-policy.js';
import { validateReceipt } from './receipts.js';
import { submitCalldata } from './wire.js';
import { json } from './math.js';
import { record } from './book.js';
import { sizeGas } from './gas.js';
import { nonceRecoveries, validateCancellationReceipt, verifyCancellationSigner } from './nonce-recovery-journal.js';
import { testnetJournalPath } from './monad-keys.js';
import { verifyHistoryRecoveryAudit } from './history-recovery-journal.js';
import { workerNamespace } from './worker.js';

export type BudgetOptions={config:MarketConfig;abi:unknown;rpcUrl:string;journalDirectory:string};
const schemas=['source','packets','signer','transactions'] as const;
function profile(p:TestnetRunPolicy):string{return relayProfileBody({chainId:10143n,...p.budget},p.relay);}
function policies(oldRaw:unknown,nextRaw:unknown){
  const old=parseTestnetRunPolicy(oldRaw),next=parseTestnetRunPolicy(nextRaw);
  const allowed={...old.relay,...(next.relay.gasSafetyMarginBps!==undefined?{gasSafetyMarginBps:next.relay.gasSafetyMarginBps}:{})};
  if(old.sender.toLowerCase()!==next.sender.toLowerCase()||json(allowed)!==json(next.relay)
    ||old.relay.gasSafetyMarginBps!==undefined&&old.relay.gasSafetyMarginBps!==next.relay.gasSafetyMarginBps
    ||next.relay.gasSafetyMarginBps===undefined||next.budget.budgetRevision!==(old.budget.budgetRevision??0)+1
    ||next.budget.maxTransactions<=old.budget.maxTransactions||next.budget.totalMaxCostWei<=old.budget.totalMaxCostWei)
    throw new Error('BUDGET_RENEWAL_SCOPE');
  return {old,next};
}
export function openBudgetJournals(options:BudgetOptions,write:boolean){
  const root=options.journalDirectory,stat=lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('TESTNET_PRIVATE_DIRECTORY_REQUIRED');
  for(const name of [...schemas,'relay']){
    const path=join(root,name+'.sqlite');if(!existsSync(path))throw new Error('TESTNET_JOURNALS_MISSING');
    const f=lstatSync(path);if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid?.())throw new Error('TESTNET_PRIVATE_FILE_REQUIRED');
    testnetJournalPath(path,false);
  }
  const db=new DatabaseSync(join(root,'relay.sqlite'),{readOnly:!write,timeout:1000});
  try{
    for(const name of schemas)db.prepare(`ATTACH DATABASE ? AS ${name}`).run(join(root,name+'.sqlite'));
    if(write)db.exec('PRAGMA synchronous=FULL');
    return db;
  }catch(error){db.close();throw error;}
}
const tables=[['main','relay_control','id'],['main','relay_nonce','sender'],['main','relay_signer','sender'],['main','deliveries','key'],
  ['source','writers','worker'],['source','captures','id'],['packets','packet_workers','ns'],['packets','packets','ns,sequence'],
  ['signer','signer_fences','ns'],['signer','signer_reservations','identity'],
  ['transactions','transaction_signer','id'],['transactions','transaction_reservations','nonce']] as const;
export function budgetJournalSnapshot(db:DatabaseSync){
  const queries:{table:string;sql:string}[]=tables.map(([schema,table,order])=>({table:schema+'.'+table,sql:`SELECT * FROM ${schema}.${table} ORDER BY ${order}`}));
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_budget_audit'").get()){
    queries.push({table:'main.relay_budget_audit',sql:'SELECT * FROM relay_budget_audit ORDER BY revision'});
  }
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='nonce_recoveries'").get()){
    queries.push({table:'main.nonce_recoveries',sql:'SELECT * FROM nonce_recoveries ORDER BY key'});
  }
  if(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_history_recovery_audit'").get()){
    queries.push({table:'main.relay_history_recovery_audit',sql:'SELECT * FROM relay_history_recovery_audit ORDER BY revision'});
  }
  // Preserve the exact existing pretty-JSON hash without constructing one huge
  // string. Real source archives exceed V8's maximum string length in hours.
  const hash=createHash('sha256');hash.update('[\n');
  queries.forEach(({table,sql},i)=>{
    if(i)hash.update(',\n');
    hash.update(`  {\n    "table": ${JSON.stringify(table)},\n    "rows": [`);
    const query=db.prepare(sql);query.setReadBigInts(true);let count=0;
    for(const row of query.iterate()){
      hash.update(count++?',\n':'\n');
      hash.update(json(row).split('\n').map(line=>'      '+line).join('\n'));
    }
    if(count)hash.update('\n    ');
    hash.update(']\n  }');
  });
  return hash.update('\n]').digest('hex');
}
async function proof(db:DatabaseSync,options:BudgetOptions,old:TestnetRunPolicy,rpc:MonadSubmissionRpc,now:()=>bigint,
  expectedQuarantine?:'SIGNED_SOURCE_HISTORY_MISMATCH'){
  const cfg=validateMonadLifecycleConfig(parseConfig(structuredClone(options.config))),d=cfg.destination!;
  const abi=parseEngineReadAbi(options.abi).abi,domain:PacketDomain={chainId:10143n,engine:d.engineAddress,
    marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress},ns=packetNamespace(domain);
  const control=db.prepare('SELECT profile,reason FROM relay_control WHERE id=1').get();
  if(control?.profile!==profile(old))throw new Error('RELAY_PROFILE_CHANGED');
  if(expectedQuarantine?control.reason!==expectedQuarantine:!!control.reason)throw new Error('RELAY_PERSISTENT_QUARANTINE');
  verifyBudgetAudit(db,String(control.profile),old.budget.budgetRevision??0);
  verifyHistoryRecoveryAudit(db,old.sender);
  for(const table of ['main.relay_nonce','source.writers','packets.packet_workers'])
    if(db.prepare(`SELECT until_ms FROM ${table}`).all().some(r=>BigInt(String(r.until_ms))>now()))throw new Error('BUDGET_IDLE_JOURNALS_REQUIRED');
  const accounts=db.prepare('SELECT * FROM relay_nonce').all(),meta=db.prepare('SELECT * FROM transactions.transaction_signer').all();
  if(accounts.length!==1||accounts[0]!.sender!==old.sender.toLowerCase()||meta.length!==1||meta[0]!.sender!==old.sender.toLowerCase()
    ||meta[0]!.chain_id!=='10143'||meta[0]!.schema_version!==1)throw new Error('BUDGET_SENDER_IDENTITY_MISMATCH');
  const pin=db.prepare('SELECT sender,journal_id FROM relay_signer').all();
  if(pin.length!==1||pin[0]!.sender!==old.sender.toLowerCase()||pin[0]!.journal_id!==meta[0]!.id)throw new Error('RELAY_TRANSACTION_SIGNER_CHANGED');
  const store=new PacketStore(join(options.journalDirectory,'packets.sqlite'),true),source=new Journal(join(options.journalDirectory,'source.sqlite'),true);
  try{
    if(!source.verify()||!store.verify())throw new Error('TESTNET_JOURNAL_INTEGRITY');
    if(db.prepare('SELECT ns FROM packets.packet_workers').all().some(r=>r.ns!==ns))throw new Error('BUDGET_SINGLE_DOMAIN_REQUIRED');
    const packets=store.list(domain),bySequence=new Map(packets.map(p=>[p.packet.observation.sequence.toString(),p]));
    const reservations=db.prepare('SELECT * FROM signer.signer_reservations').all();
    for(const row of reservations){
      const saved=bySequence.get(String(row.sequence));
      if(row.ns!==ns||row.identity!==ns+':'+row.sequence||policyHash(`${row.identity}:${row.digest}:${row.signature??''}`)!==row.sha256
        ||!saved||saved.digest!==row.digest||saved.signature!==row.signature)throw new Error('SIGNER_JOURNAL_AHEAD_OR_MISMATCH');
    }
    for(const packet of packets){
      if(packet.signature&&(!reservations.some(r=>r.sequence===packet.packet.observation.sequence.toString())
        ||(await recoverAddress({hash:packet.digest,signature:packet.signature})).toLowerCase()!==d.signerAddress.toLowerCase()))
        throw new Error('SIGNER_JOURNAL_BEHIND_OR_MISMATCH');
    }
    const transactionRows=db.prepare('SELECT * FROM transactions.transaction_reservations').all();
    const rows=db.prepare('SELECT * FROM deliveries').all();
    const deliveries:{record:Record<string,any>;packet:PreparedPacket;nonce:bigint}[]=[];
    let reservedWei=0n;
    for(const row of rows){
      const body=String(row.body);if(policyHash(body)!==row.sha256)throw new Error('DELIVERY_JOURNAL_INTEGRITY');
      const r=JSON.parse(body),packet=bySequence.get(String(r.sequence)),request=parseTransactionRequest(r.request);
      if(!['FINALIZED','CANCELLED'].includes(r.state)||!r.raw||r.state==='FINALIZED'&&!r.accepted||r.namespace!==ns||row.ns!==ns||row.key!==ns+':'+r.sequence
        ||row.nonce!==r.nonce||request.nonce.toString()!==r.nonce||!packet?.signature||packet.state!=='SIGNED'
        ||r.digest!==packet.digest||request.to!==d.engineAddress.toLowerCase()||request.data!==submitCalldata(packet.packet.observation,packet.signature).toLowerCase())
        throw new Error('BUDGET_FINALIZED_HISTORY_REQUIRED');
      const tx=parseTransaction(r.raw as Hex),signed=transactionRows.find(t=>t.nonce===r.nonce);
      if(r.gasSizing&&(BigInt(r.gasSizing.gasLimit)!==request.gas
        ||sizeGas(BigInt(r.gasSizing.estimatedGas),request.gas,BigInt(r.gasSizing.marginBps)).gasLimit!==request.gas
        ||old.relay.gasSafetyMarginBps!==BigInt(r.gasSizing.marginBps)))throw new Error('DELIVERY_JOURNAL_INTEGRITY');
      if(tx.chainId!==10143||tx.type!=='eip1559'||tx.nonce!==Number(request.nonce)||tx.to?.toLowerCase()!==request.to
        ||tx.data!==request.data||(tx.value??0n)!==0n||tx.gas!==request.gas||tx.maxFeePerGas!==request.maxFeePerGas
        ||tx.maxPriorityFeePerGas!==request.maxPriorityFeePerGas||keccak256(r.raw)!==r.txHash
        ||request.gas>old.relay.gasCap||request.maxFeePerGas>old.relay.maxFeePerGas||request.maxPriorityFeePerGas>old.relay.maxPriorityFeePerGas
        ||request.gas*request.maxFeePerGas>old.relay.maxCostWei
        ||!signed||signed.request!==json(request)||signed.raw!==r.raw||signed.tx_hash!==r.txHash
        ||policyHash(`${signed.request}:${signed.raw}:${signed.tx_hash}`)!==signed.sha256
        ||(await recoverTransactionAddress({serializedTransaction:r.raw as TransactionSerialized})).toLowerCase()!==old.sender.toLowerCase())
        throw new Error('TRANSACTION_SIGNER_RELAY_MISMATCH');
      reservedWei+=request.gas*request.maxFeePerGas;deliveries.push({record:r,packet:packet.packet,nonce:request.nonce});
    }
    if(transactionRows.length!==deliveries.length||packets.some(p=>p.state!=='EXPIRED'&&!deliveries.some(r=>r.record.sequence===p.packet.observation.sequence.toString())))
      throw new Error('BUDGET_UNRESOLVED_HISTORY');
    deliveries.sort((a,b)=>a.nonce<b.nonce?-1:1);
    const initial=BigInt(String(accounts[0]!.initial_nonce)),next=BigInt(String(accounts[0]!.next_nonce));
    if(next!==initial+BigInt(deliveries.length)||deliveries.some((r,i)=>r.nonce!==initial+BigInt(i)))throw new Error('RELAY_NONCE_JOURNAL_INTEGRITY');
    const recovered=nonceRecoveries(db);reservedWei+=recovered.reduce((s,r)=>s+BigInt(r.reservationWei),0n);
    if(recovered.some(r=>r.state!=='FINALIZED'))throw new Error('BUDGET_UNRESOLVED_HISTORY');
    if(reservedWei>old.budget.totalMaxCostWei||deliveries.length+recovered.length>old.budget.maxTransactions)throw new Error('BUDGET_HISTORY_EXCEEDS_POLICY');
    const checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi},now),last=deliveries.filter(r=>r.record.state==='FINALIZED').at(-1)?.packet.observation;
    if(checkpoint.engine!.sourceState.lastSequence!==(last?.sequence??0n)
      ||checkpoint.engine!.sourceState.lastObservedAt!==(last?.observedAt??0n))throw new Error('BUDGET_CHAIN_HISTORY_CHANGED');
    // A large history must not burst hundreds of RPC requests at once. Keep
    // every receipt/canonical-block check, and drain in-flight reads before
    // returning the first failure or releasing journal locks.
    let receiptCursor=0,receiptFailed=false,receiptError:unknown;
    const verifyNextReceipt=async()=>{
      while(!receiptFailed&&receiptCursor<deliveries.length){
        const entry=deliveries[receiptCursor++]!;
        try{await verifyReceipt(entry);}catch(error){
          if(!receiptFailed){receiptFailed=true;receiptError=error;}
        }
      }
    };
    const verifyReceipt=async(entry:typeof deliveries[number])=>{
      if(entry.record.state==='CANCELLED')return;
      const r=entry.record,receipt=await rpc.receipt(r.txHash as Hex);
      if(!receipt||receipt.blockNumber>checkpoint.block.number)throw new Error('BUDGET_FINALIZED_HISTORY_REQUIRED');
      const block=await rpc.block({blockNumber:receipt.blockNumber});
      const accepted=validateReceipt(entry.packet,r.txHash,receipt,block,{depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad)});
      if(json(accepted)!==json(r.accepted))throw new Error('BUDGET_ACCEPTED_RECEIPT_CHANGED');
    };
    await Promise.all(Array.from({length:Math.min(8,deliveries.length)},verifyNextReceipt));
    if(receiptFailed)throw receiptError;
    for(const r of recovered){
      await verifyCancellationSigner(r);const receipt=await rpc.receipt(r.hash!);
      if(!receipt||receipt.blockNumber>checkpoint.block.number)throw new Error('BUDGET_FINALIZED_HISTORY_REQUIRED');
      validateCancellationReceipt(r,receipt);const block=await rpc.block({blockNumber:receipt.blockNumber});
      if(block.hash!==receipt.blockHash||json(receipt)!==json(r.receipt))throw new Error('NONCE_RECOVERY_CANONICAL_MISMATCH');
    }
    if(await rpc.nonce(old.sender as Hex)!==next)throw new Error('BUDGET_SENDER_NONCE_CHANGED');
    const balanceWei=await rpc.balance(old.sender as Hex);
    if(now()-checkpoint.checkedAtMs>30000n)throw new Error('BUDGET_CHECKPOINT_EXPIRED');
    return {checkpoint,reservedWei,deliveryCount:deliveries.length+recovered.length,nextNonce:next,balanceWei,configHash:policyHash(json(cfg)),journalHash:budgetJournalSnapshot(db)};
  }finally{store.close();source.close();}
}

export function budgetPlanHash(value:unknown):string {
  const {approvalHash:_,...body}=record(value);return policyHash(json(body));
}
/** Read-only retirement evidence. Does not change budgets, leases, policy or history. */
export async function auditMonadPublisherRetirement(options:BudgetOptions,rawPolicy:unknown,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),now:()=>bigint=()=>BigInt(Date.now())){
  const policy=parseTestnetRunPolicy(rawPolicy),db=openBudgetJournals(options,false);
  try{
    db.exec('BEGIN');
    const state=await proof(db,options,policy,rpc,now);
    return JSON.parse(json({schemaVersion:'1',mode:'MONAD_TESTNET_RETIREMENT_AUDIT',
      sender:policy.sender,createdAtMs:now(),...state,transactionsSent:0,signaturesProduced:0}));
  }finally{db.exec('ROLLBACK');db.close();}
}
/** Read-only preview; never unlocks keys, allocates a sequence/nonce or raises the budget. */
export async function planMonadBudget(options:BudgetOptions,oldPolicy:unknown,nextPolicy:unknown,id:string,reason:string,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),now:()=>bigint=()=>BigInt(Date.now())){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||!reason||reason.length>280)throw new Error('BAD_BUDGET_RENEWAL_ID');
  const {old,next}=policies(oldPolicy,nextPolicy),db=openBudgetJournals(options,false);
  try{
    db.exec('BEGIN');
    const state=await proof(db,options,old,rpc,now),remainingReservationWei=next.budget.totalMaxCostWei-state.reservedWei;
    const body=JSON.parse(json({schemaVersion:'1',mode:'MONAD_TESTNET_BUDGET_PLAN',id,reason,oldPolicy,nextPolicy,
      createdAtMs:now(),...state,remainingReservationWei,fundingGapWei:remainingReservationWei>state.balanceWei?remainingReservationWei-state.balanceWei:0n,
      additionalTransactionSlots:next.budget.maxTransactions-old.budget.maxTransactions,
      additionalReservationWei:next.budget.totalMaxCostWei-old.budget.totalMaxCostWei,
      productionApproved:false,transactionsSent:0,signaturesProduced:0}));
    return {...body,approvalHash:policyHash(json(body))};
  }finally{db.exec('ROLLBACK');db.close();}
}
/** One atomic relay-only policy/audit update under write locks on all five journals. */
export async function applyMonadBudget(options:BudgetOptions,value:unknown,expectedHash:string,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),now:()=>bigint=()=>BigInt(Date.now())){
  const plan=record(structuredClone(value));
  if(!/^[0-9a-f]{64}$/.test(expectedHash)||plan.approvalHash!==expectedHash||budgetPlanHash(plan)!==expectedHash
    ||plan.schemaVersion!=='1'||plan.mode!=='MONAD_TESTNET_BUDGET_PLAN')throw new Error('BUDGET_PLAN_CHANGED');
  const {old,next}=policies(plan.oldPolicy,plan.nextPolicy),db=openBudgetJournals(options,true);
  let committed=false;
  try{
    db.exec('BEGIN IMMEDIATE');
    // Safe replay of a committed transition never adds budget again.
    if(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_budget_audit'").get()){
      const done=db.prepare('SELECT body FROM relay_budget_audit WHERE revision=?').get(next.budget.budgetRevision!);
      if(done){
        const entry=JSON.parse(String(done.body));
        if(entry.approvalHash!==expectedHash)throw new Error('BUDGET_REVISION_CONFLICT');
        verifyBudgetAudit(db,String(db.prepare('SELECT profile FROM relay_control WHERE id=1').get()!.profile),next.budget.budgetRevision);
        return {mode:'MONAD_TESTNET_BUDGET_RENEWAL',alreadyApplied:true,revision:next.budget.budgetRevision,approvalHash:expectedHash,transactionsSent:0};
      }
    }
    if(budgetJournalSnapshot(db)!==plan.journalHash)throw new Error('BUDGET_JOURNALS_CHANGED');
    const state=await proof(db,options,old,rpc,now);
    if(state.configHash!==plan.configHash||state.nextNonce.toString()!==plan.nextNonce
      ||state.checkpoint.engine!.sourceState.lastSequence.toString()!==(plan.checkpoint as any).engine.sourceState.lastSequence)
      throw new Error('BUDGET_CHAIN_HISTORY_CHANGED');
    const remaining=next.budget.totalMaxCostWei-state.reservedWei;
    if(state.balanceWei<remaining)throw new Error('BUDGET_SENDER_NEEDS_TEST_MON');
    if(budgetJournalSnapshot(db)!==plan.journalHash)throw new Error('BUDGET_JOURNALS_CHANGED');
    const previous=db.prepare("SELECT name FROM sqlite_master WHERE name='relay_budget_audit'").get()
      ?db.prepare('SELECT sha256 FROM relay_budget_audit ORDER BY revision DESC LIMIT 1').get()?.sha256??null:null;
    const body=json({revision:next.budget.budgetRevision,id:plan.id,reason:plan.reason,approvalHash:expectedHash,
      previousHash:previous,fromProfile:profile(old),toProfile:profile(next),journalHashBefore:state.journalHash,
      historicalReservationsWei:state.reservedWei,deliveryCount:state.deliveryCount,nextNonce:state.nextNonce,
      checkpoint:state.checkpoint,appliedAtMs:now()});
    db.exec('CREATE TABLE IF NOT EXISTS relay_budget_audit(revision INTEGER PRIMARY KEY,body TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT');
    db.prepare('INSERT INTO relay_budget_audit VALUES(?,?,?)').run(next.budget.budgetRevision!,body,policyHash(body));
    if(db.prepare('UPDATE relay_control SET profile=? WHERE id=1 AND profile=? AND reason IS NULL').run(profile(next),profile(old)).changes!==1)
      throw new Error('RELAY_PROFILE_CHANGED');
    verifyBudgetAudit(db,profile(next),next.budget.budgetRevision);db.exec('COMMIT');committed=true;
    return {mode:'MONAD_TESTNET_BUDGET_RENEWAL',alreadyApplied:false,revision:next.budget.budgetRevision,
      approvalHash:expectedHash,historicalReservationsWei:state.reservedWei,remainingReservationWei:remaining,
      deliveryCount:state.deliveryCount,nextNonce:state.nextNonce,transactionsSent:0,signaturesProduced:0,productionApproved:false};
  }finally{if(!committed)db.exec('ROLLBACK');db.close();}
}

function recoveryReadRpc(rpc:MonadSubmissionRpc,timeoutMs:number):MonadSubmissionRpc {
  const bounded=async<T>(call:()=>Promise<T>):Promise<T>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(call),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(Error('HISTORY_RECOVERY_RPC_UNAVAILABLE')),timeoutMs);
    })]);}catch{throw Error('HISTORY_RECOVERY_RPC_UNAVAILABLE');}finally{if(timer)clearTimeout(timer);}
  };
  return {chainId:()=>bounded(()=>rpc.chainId()),block:s=>bounded(()=>rpc.block(s)),code:(a,b)=>bounded(()=>rpc.code(a,b)),
    ...(rpc.codeHash?{codeHash:(a:Hex,b:bigint)=>bounded(()=>rpc.codeHash!(a,b))}:{}),
    read:(a,b,n,s,k)=>bounded(()=>rpc.read(a,b,n,s,k)),nonce:a=>bounded(()=>rpc.nonce(a)),balance:a=>bounded(()=>rpc.balance(a)),
    receipt:h=>bounded(()=>rpc.receipt(h)),simulate:async()=>{throw Error('HISTORY_RECOVERY_READ_ONLY');},send:async()=>{throw Error('HISTORY_RECOVERY_READ_ONLY');}};
}

async function laggedFinalizedViewProof(db:DatabaseSync,options:BudgetOptions,policy:TestnetRunPolicy,rpc:MonadSubmissionRpc,now:()=>bigint){
  // Reuse the complete receipt/signature/nonce/budget proof. The sole admission
  // difference is requiring this exact persisted reason rather than no reason.
  const state=await proof(db,options,policy,rpc,now,'SIGNED_SOURCE_HISTORY_MISMATCH');
  const cfg=parseConfig(structuredClone(options.config)),d=cfg.destination!;
  const row=db.prepare('SELECT id,payload,sha256 FROM source.captures WHERE worker=? ORDER BY id DESC LIMIT 1')
    .get(`lifecycle:${workerNamespace(cfg)}`);
  if(!row||policyHash(String(row.payload))!==row.sha256)throw Error('HISTORY_RECOVERY_LAG_EVIDENCE_REQUIRED');
  const view=JSON.parse(String(row.payload)),checkpoint=view.checkpoint;
  if(view.recordType!=='LIFECYCLE'||view.schemaVersion!=='1'||view.configDigest!==state.configHash
    ||!['COLLECTING','RECORD_ONLY'].includes(view.mode)||view.reason!==null||view.freshCheckpoint!==true
    ||checkpoint?.canonical!==true||checkpoint.chainId!=='10143'||checkpoint.engine?.toLowerCase()!==d.engineAddress.toLowerCase()
    ||checkpoint.marketId?.toLowerCase()!==d.marketId.toLowerCase()||checkpoint.sourceId?.toLowerCase()!==d.sourceId.toLowerCase()
    ||checkpoint.engineCodeHash?.toLowerCase()!==d.engineCodeHash.toLowerCase()||checkpoint.rulesHash?.toLowerCase()!==d.sourceRulesHash.toLowerCase()
    ||checkpoint.scheduledT!==d.scheduledT||!/^\d+$/.test(checkpoint.blockNumber??''))throw Error('HISTORY_RECOVERY_LAG_EVIDENCE_REQUIRED');
  const deliveries=db.prepare('SELECT body FROM deliveries').all().map(r=>JSON.parse(String(r.body))).filter(r=>r.state==='FINALIZED');
  const last=deliveries.reduce((a,b)=>!a||BigInt(a.sequence)<BigInt(b.sequence)?b:a,null);
  if(!last?.accepted||BigInt(checkpoint.blockNumber)>=BigInt(last.accepted.blockNumber)
    ||!/^\d+$/.test(checkpoint.sourceState?.lastSequence??'')||BigInt(checkpoint.sourceState.lastSequence)>=BigInt(last.sequence))
    throw Error('HISTORY_RECOVERY_NOT_AN_OLDER_FINALIZED_VIEW');
  const [canonical,source]=await Promise.all([
    rpc.block({blockNumber:BigInt(checkpoint.blockNumber)}),
    rpc.read(d.engineAddress as Hex,parseEngineReadAbi(options.abi).abi,'sourceState',d.sourceId as Hex,BigInt(checkpoint.blockNumber)),
  ]);
  const historical=record(source);
  if(canonical.hash.toLowerCase()!==checkpoint.blockHash.toLowerCase()||canonical.timestamp.toString()!==checkpoint.blockTimestamp
    ||historical.lastSequence?.toString()!==checkpoint.sourceState.lastSequence
    ||historical.lastObservedAt?.toString()!==checkpoint.sourceState.lastObservedAt
    ||String(historical.signer).toLowerCase()!==d.signerAddress.toLowerCase()||String(historical.rulesHash).toLowerCase()!==d.sourceRulesHash.toLowerCase()
    ||historical.configured!==true)throw Error('HISTORY_RECOVERY_HISTORICAL_VIEW_CHANGED');
  const finalAnchor=await rpc.block({blockNumber:state.checkpoint.block.number});
  if(finalAnchor.hash!==state.checkpoint.block.hash||now()-state.checkpoint.checkedAtMs>30000n)throw Error('HISTORY_RECOVERY_CHECKPOINT_CHANGED_OR_EXPIRED');
  return {...state,lagEvidence:{captureId:String(row.id),captureSha256:String(row.sha256),snapshotBlock:checkpoint.blockNumber,
    snapshotHash:checkpoint.blockHash,snapshotSequence:checkpoint.sourceState.lastSequence,acceptedBlock:last.accepted.blockNumber,
    acceptedHash:last.accepted.blockHash,acceptedSequence:last.sequence,transactionHash:last.txHash}};
}

/** Read-only review of a provably older RPC view. No keys, signing, nonce change or database edit. */
export async function planMonadHistoryRecovery(options:BudgetOptions,rawPolicy:unknown,id:string,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),now:()=>bigint=()=>BigInt(Date.now())){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw Error('BAD_HISTORY_RECOVERY_ID');
  const policy=parseTestnetRunPolicy(rawPolicy),db=openBudgetJournals(options,false);
  rpc=recoveryReadRpc(rpc,policy.relay.timeoutMs);
  try{
    db.exec('BEGIN');
    const state=await laggedFinalizedViewProof(db,options,policy,rpc,now);
    const body=JSON.parse(json({schemaVersion:'1',mode:'MONAD_TESTNET_FINALIZED_VIEW_RECOVERY_PLAN',id,policy:rawPolicy,
      reason:'SIGNED_SOURCE_HISTORY_MISMATCH',createdAtMs:now(),...state,signaturesProduced:0,transactionsSent:0,productionApproved:false}));
    return {...body,approvalHash:policyHash(json(body))};
  }finally{db.exec('ROLLBACK');db.close();}
}

/** Atomic, review-hash-bound recovery. Preserve all history and append the precise stale-view proof. */
export async function applyMonadHistoryRecovery(options:BudgetOptions,value:unknown,expectedHash:string,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),now:()=>bigint=()=>BigInt(Date.now())){
  const plan=record(structuredClone(value));
  if(!/^[a-f0-9]{64}$/.test(expectedHash)||plan.approvalHash!==expectedHash||budgetPlanHash(plan)!==expectedHash
    ||plan.schemaVersion!=='1'||plan.mode!=='MONAD_TESTNET_FINALIZED_VIEW_RECOVERY_PLAN'||plan.reason!=='SIGNED_SOURCE_HISTORY_MISMATCH')
    throw Error('HISTORY_RECOVERY_PLAN_CHANGED');
  const policy=parseTestnetRunPolicy(plan.policy),db=openBudgetJournals(options,true);
  rpc=recoveryReadRpc(rpc,policy.relay.timeoutMs);let committed=false;
  try{
    db.exec('BEGIN IMMEDIATE');verifyHistoryRecoveryAudit(db,policy.sender);
    if(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_history_recovery_audit'").get()){
      const done=db.prepare('SELECT body FROM relay_history_recovery_audit WHERE approval_hash=?').get(expectedHash);
      if(done)return {mode:'MONAD_TESTNET_FINALIZED_VIEW_RECOVERY',alreadyApplied:true,approvalHash:expectedHash,transactionsSent:0,signaturesProduced:0};
    }
    if(budgetJournalSnapshot(db)!==plan.journalHash)throw Error('HISTORY_RECOVERY_JOURNALS_CHANGED');
    const state=await laggedFinalizedViewProof(db,options,policy,rpc,now);
    if(state.configHash!==plan.configHash||state.nextNonce.toString()!==plan.nextNonce||json(state.lagEvidence)!==json(plan.lagEvidence)
      ||state.checkpoint.engine!.sourceState.lastSequence.toString()!==(plan.checkpoint as any).engine.sourceState.lastSequence)
      throw Error('HISTORY_RECOVERY_EVIDENCE_CHANGED');
    if(budgetJournalSnapshot(db)!==plan.journalHash)throw Error('HISTORY_RECOVERY_JOURNALS_CHANGED');
    const control=db.prepare('SELECT * FROM relay_control WHERE id=1').get()!,revision=Number(control.history_revision??0)+1;
    const previous=revision>1?db.prepare('SELECT sha256 FROM relay_history_recovery_audit WHERE revision=?').get(revision-1)!.sha256:null;
    const body=json({mode:'MONAD_TESTNET_FINALIZED_VIEW_RECOVERY',chainId:10143,revision,id:plan.id,reason:plan.reason,sender:policy.sender,
      profile:String(control.profile),approvalHash:expectedHash,previousHash:previous,journalHashBefore:state.journalHash,
      lagEvidence:state.lagEvidence,checkpoint:state.checkpoint,nextNonce:state.nextNonce,historicalReservationsWei:state.reservedWei,appliedAtMs:now()});
    if(!db.prepare('PRAGMA table_info(relay_control)').all().some(c=>c.name==='history_revision'))
      db.exec('ALTER TABLE relay_control ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE TABLE IF NOT EXISTS relay_history_recovery_audit(revision INTEGER PRIMARY KEY,approval_hash TEXT NOT NULL UNIQUE,body TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT');
    db.prepare('INSERT INTO relay_history_recovery_audit VALUES(?,?,?,?)').run(revision,expectedHash,body,policyHash(body));
    if(db.prepare('UPDATE relay_control SET reason=NULL,history_revision=? WHERE id=1 AND profile=? AND reason=?')
      .run(revision,profile(policy),'SIGNED_SOURCE_HISTORY_MISMATCH').changes!==1)throw Error('HISTORY_RECOVERY_CONTROL_CHANGED');
    verifyHistoryRecoveryAudit(db,policy.sender);db.exec('COMMIT');committed=true;
    return {mode:'MONAD_TESTNET_FINALIZED_VIEW_RECOVERY',alreadyApplied:false,approvalHash:expectedHash,revision,nextNonce:state.nextNonce,
      historicalReservationsWei:state.reservedWei,transactionsSent:0,signaturesProduced:0,productionApproved:false};
  }finally{if(!committed)db.exec('ROLLBACK');db.close();}
}
