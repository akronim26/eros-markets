import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { openBudgetJournals, type BudgetOptions } from './monad-budget.js';
import { nonceRecoveries, saveRecovery, validateCancellationReceipt, verifyCancellationSigner, type NonceRecovery } from './nonce-recovery-journal.js';
import { parseTestnetRunPolicy } from './monad-service.js';
import { policyHash, relayProfileBody, verifyBudgetAudit } from './relay-policy.js';
import { preflightMonadTestnet } from './monad-preflight.js';
import { monadSubmissionRpc, type MonadSubmissionRpc } from './monad-rpc.js';
import { loadTestnetKey } from './monad-keys.js';
import { PacketStore, packetNamespace } from './packet-store.js';
import { Journal } from './journal.js';
import { json } from './math.js';
import { validateReceipt } from './receipts.js';
import { submitCalldata } from './wire.js';

type RecoveryOptions=BudgetOptions&{keysDirectory:string;policy:unknown;nonce:bigint;originalHash:Hex;maxCostWei:bigint;waitMs:number};
/** Only cancels a known signed, never-broadcast, expired final reservation.
 * Zero-value, empty-data, 21,000-gas self transaction; no arbitrary signing path.
 * Original price signature/request/raw bytes and every reservation are retained.
 */
export async function recoverMonadNonce(options:RecoveryOptions,rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),
  now:()=>bigint=()=>BigInt(Date.now()),testAccount?:PrivateKeyAccount){
  if(!/^0x[\da-fA-F]{64}$/.test(options.originalHash)||options.nonce<0n||options.nonce>BigInt(Number.MAX_SAFE_INTEGER)
    ||options.maxCostWei<=0n||!Number.isSafeInteger(options.waitMs)||options.waitMs<1||options.waitMs>120000)
    throw new Error('BAD_NONCE_RECOVERY_LIMIT');
  const p=parseTestnetRunPolicy(options.policy),cfg=options.config,d=cfg.destination!;
  const profile=relayProfileBody({chainId:10143n,...p.budget},p.relay);
  const request={gas:'21000',maxFeePerGas:p.relay.maxFeePerGas.toString(),maxPriorityFeePerGas:p.relay.maxPriorityFeePerGas.toString()};
  const reservationWei=21000n*p.relay.maxFeePerGas;
  if(reservationWei>options.maxCostWei)throw new Error('NONCE_RECOVERY_COST_CAP');
  const domain={chainId:10143n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  const ns=packetNamespace(domain),db=openBudgetJournals(options,true);
  let locked=false;
  const begin=()=>{db.exec('BEGIN IMMEDIATE');locked=true;};
  const commit=()=>{db.exec('COMMIT');locked=false;};
  const rollback=()=>{if(locked){db.exec('ROLLBACK');locked=false;}};
  function local(){
    const control=db.prepare('SELECT * FROM relay_control WHERE id=1').get();
    if(control?.profile!==profile||control.reason)throw new Error('RELAY_PROFILE_CHANGED_OR_QUARANTINED');
    verifyBudgetAudit(db,profile,p.budget.budgetRevision??0);
    for(const table of ['relay_nonce','source.writers','packets.packet_workers'])
      if(db.prepare(`SELECT until_ms FROM ${table}`).all().some(r=>BigInt(String(r.until_ms))>now()))throw new Error('NONCE_RECOVERY_IDLE_REQUIRED');
    const meta=db.prepare('SELECT * FROM transactions.transaction_signer').all(),pin=db.prepare('SELECT * FROM relay_signer').all();
    const accounts=db.prepare('SELECT * FROM relay_nonce').all();
    if(meta.length!==1||meta[0]!.sender!==p.sender.toLowerCase()||meta[0]!.chain_id!=='10143'||pin.length!==1
      ||pin[0]!.sender!==p.sender.toLowerCase()||pin[0]!.journal_id!==meta[0]!.id||accounts.length!==1
      ||accounts[0]!.sender!==p.sender.toLowerCase()||BigInt(String(accounts[0]!.next_nonce))!==options.nonce+1n)
      throw new Error('NONCE_RECOVERY_IDENTITY_MISMATCH');
    const rows=db.prepare('SELECT * FROM deliveries').all();
    const target=rows.find(r=>r.nonce===options.nonce.toString());
    if(!target||policyHash(String(target.body))!==target.sha256)throw new Error('NONCE_RECOVERY_HISTORY_MISMATCH');
    const record=JSON.parse(String(target.body)),recoveries=nonceRecoveries(db),existing=recoveries.find(r=>r.key===target.key);
    if(record.txHash!==options.originalHash||record.namespace!==ns||!record.raw||record.accepted!==null||record.attempts!==0
      ||!existing&&(record.state!=='QUARANTINED'||!['RELAY_HEADROOM_EXPIRED','RESERVED_NONCE_HEADROOM_EXPIRED'].includes(record.reason))
      ||existing&&(existing.profile!==profile||existing.signerJournalId!==meta[0]!.id||existing.sender.toLowerCase()!==p.sender.toLowerCase()
        ||json(existing.request)!==json(request)||existing.reservationWei!==reservationWei.toString()))throw new Error('NONCE_RECOVERY_SCOPE');
    const reserved=rows.reduce((s,row)=>{if(policyHash(String(row.body))!==row.sha256)throw new Error('DELIVERY_JOURNAL_INTEGRITY');
      const r=JSON.parse(String(row.body));return s+BigInt(r.request.gas)*BigInt(r.request.maxFeePerGas);},0n)
      +recoveries.reduce((s,r)=>s+BigInt(r.reservationWei),0n)+(existing?0n:reservationWei);
    if(rows.length+recoveries.length+(existing?0:1)>p.budget.maxTransactions||reserved>p.budget.totalMaxCostWei)
      throw new Error('TESTNET_RELAY_BUDGET_EXHAUSTED');
    return {target,record,rows,existing,meta:meta[0]!,reserved};
  }
  async function chainAndHistory(state:ReturnType<typeof local>){
    const store=new PacketStore(join(options.journalDirectory,'packets.sqlite'),true),source=new Journal(join(options.journalDirectory,'source.sqlite'),true);
    try{
      if(!store.verify()||!source.verify())throw new Error('TESTNET_JOURNAL_INTEGRITY');
      const packet=store.get(domain,BigInt(state.record.sequence));
      if(!packet?.signature||packet.digest!==state.record.digest||packet.state!=='SIGNED'
        ||submitCalldata(packet.packet.observation,packet.signature).toLowerCase()!==state.record.request.data
        ||now()/1000n<=packet.packet.observation.observedAt+30n)throw new Error('NONCE_RECOVERY_NOT_EXPIRED_OR_MISMATCH');
      if((await recoverAddress({hash:packet.digest,signature:packet.signature})).toLowerCase()!==d.signerAddress.toLowerCase())
        throw new Error('NONCE_RECOVERY_IDENTITY_MISMATCH');
      const signed=db.prepare('SELECT * FROM transactions.transaction_reservations WHERE nonce=?').get(options.nonce.toString());
      const original=parseTransaction(state.record.raw);
      if(!signed||signed.raw!==state.record.raw||signed.tx_hash!==options.originalHash||signed.request!==json(state.record.request)
        ||signed.sha256!==policyHash(`${signed.request}:${signed.raw}:${signed.tx_hash}`)||keccak256(state.record.raw)!==options.originalHash
        ||original.chainId!==10143||original.type!=='eip1559'||original.nonce!==Number(options.nonce)||original.to?.toLowerCase()!==d.engineAddress.toLowerCase()
        ||original.data!==state.record.request.data||(original.value??0n)!==0n||original.gas!==BigInt(state.record.request.gas)
        ||original.maxFeePerGas!==BigInt(state.record.request.maxFeePerGas)||original.maxPriorityFeePerGas!==BigInt(state.record.request.maxPriorityFeePerGas)
        ||(await recoverTransactionAddress({serializedTransaction:state.record.raw as TransactionSerialized})).toLowerCase()!==p.sender.toLowerCase())
        throw new Error('TRANSACTION_SIGNER_RELAY_MISMATCH');
      const checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi:options.abi},now);
      const finalized=state.rows.map(r=>JSON.parse(String(r.body))).filter(r=>r.state==='FINALIZED').sort((a,b)=>Number(BigInt(a.nonce)-BigInt(b.nonce)));
      if(state.rows.some(r=>r.key!==state.target.key&&!['FINALIZED','CANCELLED'].includes(JSON.parse(String(r.body)).state)))
        throw new Error('NONCE_RECOVERY_UNRESOLVED_HISTORY');
      const last=finalized.at(-1),lastPacket=last?store.get(domain,BigInt(last.sequence)):null;
      if(checkpoint.engine!.sourceState.lastSequence!==(lastPacket?.packet.observation.sequence??0n)
        ||checkpoint.engine!.sourceState.lastObservedAt!==(lastPacket?.packet.observation.observedAt??0n))throw new Error('BUDGET_CHAIN_HISTORY_CHANGED');
      for(const r of finalized){
        const packet=store.get(domain,BigInt(r.sequence)),receipt=await rpc.receipt(r.txHash);
        if(!packet||!receipt||receipt.blockNumber>checkpoint.block.number)throw new Error('NONCE_RECOVERY_HISTORY_MISMATCH');
        const block=await rpc.block({blockNumber:receipt.blockNumber});
        if(json(validateReceipt(packet.packet,r.txHash,receipt,block,{depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad)}))!==json(r.accepted))
          throw new Error('NONCE_RECOVERY_HISTORY_MISMATCH');
      }
      const [nonce,balance,oldReceipt,code]=await Promise.all([rpc.nonce(p.sender as Hex),rpc.balance(p.sender as Hex),
        rpc.receipt(options.originalHash),rpc.code(p.sender as Hex,checkpoint.block.number)]);
      if(code&&code!=='0x')throw new Error('NONCE_RECOVERY_EOA_REQUIRED');
      if(oldReceipt)throw new Error('NONCE_RECOVERY_ORIGINAL_INCLUDED');
      if(nonce!==options.nonce&&!(state.existing&&['UNKNOWN','FINALIZED'].includes(state.existing.state)&&nonce===options.nonce+1n))
        throw new Error('NONCE_RECOVERY_CHAIN_NONCE_CHANGED');
      if(!state.existing&&balance<reservationWei)throw new Error('MONAD_SENDER_NEEDS_TEST_MON');
      return checkpoint;
    }finally{source.close();store.close();}
  }
  try{
    begin();let state=local();await chainAndHistory(state);
    let r:NonceRecovery=state.existing??{key:String(state.target.key),sender:p.sender as Hex,nonce:options.nonce.toString(),
      originalBody:String(state.target.body),originalSha256:String(state.target.sha256),request,raw:null,hash:null,state:'PREPARING',attempts:0,
      receipt:null,reservationWei:reservationWei.toString(),profile,signerJournalId:String(state.meta.id)};
    if(!state.existing){
      const estimate=await rpc.simulate(p.sender as Hex,p.sender as Hex,'0x',21000n);
      if(typeof estimate!=='bigint'||estimate>21000n||estimate<21000n)throw new Error('NONCE_RECOVERY_SIMULATION_FAILED');
      db.exec('CREATE TABLE IF NOT EXISTS nonce_recoveries(key TEXT PRIMARY KEY,body TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT');saveRecovery(db,r);
    }
    commit();await verifyCancellationSigner(r);
    if(!r.raw){
      const account=testAccount??loadTestnetKey(join(options.keysDirectory,'transaction-signer.json'),join(options.keysDirectory,'transaction-password'),p.sender);
      if(account.address.toLowerCase()!==p.sender.toLowerCase())throw new Error('KEY_IDENTITY_MISMATCH');
      const raw=await account.signTransaction({chainId:10143,type:'eip1559',to:p.sender as Hex,value:0n,data:'0x',nonce:Number(options.nonce),
        gas:21000n,maxFeePerGas:BigInt(request.maxFeePerGas),maxPriorityFeePerGas:BigInt(request.maxPriorityFeePerGas)});
      begin();state=local();const current=state.existing!;
      if(current.raw&&current.raw!==raw)throw new Error('NONCE_RECOVERY_SIGNING_CONFLICT');
      r={...current,raw,hash:keccak256(raw),state:'READY'};saveRecovery(db,r);nonceRecoveries(db);commit();
    }
    const deadline=performance.now()+options.waitMs;
    let sent=false;
    while(true){
      const receipt=await rpc.receipt(r.hash!);
      if(receipt){
        validateCancellationReceipt(r,receipt);
        const [block,head]=await Promise.all([rpc.block({blockNumber:receipt.blockNumber}),rpc.block({blockTag:'finalized'})]);
        if(block.hash!==receipt.blockHash)throw new Error('NONCE_RECOVERY_CANONICAL_MISMATCH');
        if(receipt.blockNumber<=head.number){
          begin();state=local();const checkpoint=await chainAndHistory(state);
          if(receipt.blockNumber>checkpoint.block.number)throw new Error('NONCE_RECOVERY_FINALITY_CHANGED');
          r={...state.existing!,state:'FINALIZED',receipt};
          const cancelled={...state.record,state:'CANCELLED',reason:'NONCE_CANCELLED'},body=json(cancelled);
          db.prepare('UPDATE deliveries SET body=?,sha256=? WHERE key=?').run(body,policyHash(body),r.key);
          saveRecovery(db,r);nonceRecoveries(db);commit();
          return {mode:'MONAD_TESTNET_NONCE_RECOVERY',status:'FINALIZED',nonce:r.nonce,hash:r.hash,receipt,
            cancellationReservationWei:r.reservationWei,totalReservationsWei:state.reserved,priceTransactionsSent:0,
            originalPriceRequestAndRawRetained:true,productionApproved:false};
        }
      }else if(!sent&&r.state!=='FINALIZED'){
        begin();state=local();await chainAndHistory(state);r=state.existing!;
        if(r.attempts>=p.relay.maxAttempts)throw new Error('NONCE_RECOVERY_ATTEMPTS_EXHAUSTED');
        r={...r,state:'UNKNOWN',attempts:r.attempts+1};saveRecovery(db,r);commit();
        // Persist uncertainty before network I/O. A retry can only reuse these bytes.
        try{if(await rpc.send(r.raw!)!==r.hash)throw new Error('NONCE_RECOVERY_HASH_MISMATCH');}
        catch{sent=true;}
        sent=true;
      }
      if(performance.now()>=deadline)return {mode:'MONAD_TESTNET_NONCE_RECOVERY',status:'UNKNOWN',nonce:r.nonce,hash:r.hash,
        cancellationReservationWei:r.reservationWei,priceTransactionsSent:0,productionApproved:false};
      await pause(250);
    }
  }finally{rollback();db.close();}
}
