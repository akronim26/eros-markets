import type { DatabaseSync } from 'node:sqlite';
import { keccak256, parseTransaction, recoverTransactionAddress, recoverAddress, type Hex, type TransactionSerialized } from 'viem';
import { policyHash } from './relay-policy.js';
import { json } from './math.js';
import { validateReceipt, type AcceptedReceipt, type DeliveryReceipt } from './receipts.js';
import { packetNamespace, type PacketDomain, type StoredPacket } from './packet-store.js';
import { submitCalldata } from './wire.js';

export type NonceRecovery={key:string;sender:Hex;nonce:string;originalBody:string;originalSha256:string;
  request:{gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string};
  raw:Hex|null;hash:Hex|null;state:'PREPARING'|'READY'|'UNKNOWN'|'FINALIZED'|'ORIGINAL_FINALIZED'|'ORIGINAL_REVERTED';attempts:number;
  receipt:DeliveryReceipt|null;reservationWei:string;profile:string;signerJournalId:string;
  cancellationReserved?:false;originalDomain?:Omit<PacketDomain,'chainId'>&{chainId:string};
  originalAccepted?:AcceptedReceipt|null;depthRule?:{depthNLots:string;maxSpreadWad:string};
  attemptedOriginal?:true;expiryCheckpoint?:{number:string;hash:Hex;timestamp:string;observedAt:string}};

// Only explicitly known pre-broadcast stops qualify. Recovery separately checks
// expiry, zero attempts, exact signed bytes, sender nonce and canonical history.
export function recoverableUnsentReason(reason:unknown):boolean {
  return reason==='RELAY_HEADROOM_EXPIRED'||reason==='RESERVED_NONCE_HEADROOM_EXPIRED'
    ||reason==='LIFECYCLE_BLOCKED:SOURCE_UNAVAILABLE:LIFECYCLE_RPC_UNAVAILABLE';
}

/** Separate cancellation evidence; the original immutable price request stays intact. */
export function nonceRecoveries(db:DatabaseSync):NonceRecovery[] {
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE name='nonce_recoveries'").get();
  const rows=exists?db.prepare('SELECT key,body,sha256 FROM nonce_recoveries ORDER BY key').all():[];
  const result:NonceRecovery[]=[];
  for(const row of rows){
    const body=String(row.body),r=JSON.parse(body) as NonceRecovery;
    const pinned=db.prepare('SELECT journal_id FROM relay_signer WHERE sender=?').get(String(r.sender).toLowerCase());
    const profile=JSON.parse(r.profile);
    if(policyHash(body)!==row.sha256||r.key!==row.key||policyHash(r.originalBody)!==r.originalSha256
      ||!/^0x[\da-fA-F]{40}$/.test(r.sender)||!/^\d+$/.test(r.nonce)||r.request.gas!=='21000'
      ||pinned?.journal_id!==r.signerJournalId||profile.chainId!=='10143'
      ||r.request.maxFeePerGas!==profile.relayPolicy.maxFeePerGas||r.request.maxPriorityFeePerGas!==profile.relayPolicy.maxPriorityFeePerGas
      ||BigInt(r.request.maxPriorityFeePerGas)>BigInt(r.request.maxFeePerGas)||BigInt(r.request.maxFeePerGas)<=0n
      ||r.reservationWei!==(r.cancellationReserved===false?'0':(21000n*BigInt(r.request.maxFeePerGas)).toString())
      ||r.cancellationReserved===false&&(!originalWon(r)||r.raw!==null||r.attempts!==0)
      ||!['PREPARING','READY','UNKNOWN','FINALIZED','ORIGINAL_FINALIZED','ORIGINAL_REVERTED'].includes(r.state)||!Number.isSafeInteger(r.attempts)||r.attempts<0)
      throw new Error('NONCE_RECOVERY_INTEGRITY');
    const old=JSON.parse(r.originalBody),current=db.prepare('SELECT body,sha256 FROM deliveries WHERE key=?').get(r.key);
    if(!current||policyHash(String(current.body))!==current.sha256)throw new Error('NONCE_RECOVERY_INTEGRITY');
    const delivery=JSON.parse(String(current.body));
    if(old.state!=='QUARANTINED'||(!r.attemptedOriginal?old.attempts!==0:
        !Number.isSafeInteger(old.attempts)||old.attempts<1||old.attempts>profile.relayPolicy.maxAttempts
        ||old.reason!=='RESERVED_NONCE_HEADROOM_EXPIRED'||!r.expiryCheckpoint
        ||!/^\d+$/.test(r.expiryCheckpoint.number)||!/^0x[\da-fA-F]{64}$/.test(r.expiryCheckpoint.hash)
        ||!/^\d+$/.test(r.expiryCheckpoint.timestamp)||!/^\d+$/.test(r.expiryCheckpoint.observedAt)
        ||BigInt(r.expiryCheckpoint.timestamp)<=BigInt(r.expiryCheckpoint.observedAt)+30n)
      ||old.nonce!==r.nonce||!old.raw||old.accepted!==null
      ||!recoverableUnsentReason(old.reason)
      ||json({...delivery,state:old.state,reason:old.reason,accepted:originalWon(r)?old.accepted:delivery.accepted})!==r.originalBody
      ||delivery.state!==(r.state==='FINALIZED'?'CANCELLED':r.state==='ORIGINAL_FINALIZED'?'FINALIZED':r.state==='ORIGINAL_REVERTED'?'REVERTED':'QUARANTINED')
      ||r.state==='FINALIZED'&&delivery.reason!=='NONCE_CANCELLED'
      ||r.state==='ORIGINAL_FINALIZED'&&(delivery.reason!==null||json(delivery.accepted)!==json(r.originalAccepted))
      ||r.state==='ORIGINAL_REVERTED'&&(delivery.reason!=='NONCE_RECOVERY_ORIGINAL_REVERTED'||delivery.accepted!==null))throw new Error('NONCE_RECOVERY_INTEGRITY');
    if(r.raw){
      const tx=parseTransaction(r.raw);
      if(keccak256(r.raw)!==r.hash||tx.type!=='eip1559'||tx.chainId!==10143||tx.nonce!==Number(r.nonce)
        ||tx.to?.toLowerCase()!==r.sender.toLowerCase()||(tx.value??0n)!==0n||(tx.data??'0x')!=='0x'
        ||tx.gas!==21000n||tx.maxFeePerGas!==BigInt(r.request.maxFeePerGas)
        ||tx.maxPriorityFeePerGas!==BigInt(r.request.maxPriorityFeePerGas))throw new Error('NONCE_RECOVERY_SCOPE');
    }else if(r.hash||r.state!=='PREPARING'&&!originalWon(r)||r.attempts!==0)throw new Error('NONCE_RECOVERY_INTEGRITY');
    if(r.state==='FINALIZED'){if(!r.receipt||!r.hash)throw new Error('NONCE_RECOVERY_INTEGRITY');validateCancellationReceipt(r,r.receipt);}
    else if(originalWon(r)){
      if(!r.receipt||!r.originalDomain||!r.depthRule||packetNamespace({...r.originalDomain,chainId:BigInt(r.originalDomain.chainId)})!==old.namespace
        ||r.receipt.transactionHash!==old.txHash||r.receipt.status!==(r.state==='ORIGINAL_FINALIZED'?'success':'reverted')
        ||(r.state==='ORIGINAL_FINALIZED'?!r.originalAccepted:r.originalAccepted!==null))throw new Error('NONCE_RECOVERY_INTEGRITY');
    }else if(r.receipt!==null)throw new Error('NONCE_RECOVERY_INTEGRITY');
    result.push(r);
  }
  for(const row of db.prepare('SELECT key,body FROM deliveries').all())
    if((JSON.parse(String(row.body)).state==='CANCELLED'&&!result.some(r=>r.key===row.key&&r.state==='FINALIZED'))
      ||JSON.parse(String(row.body)).reason==='NONCE_RECOVERY_ORIGINAL_REVERTED'&&!result.some(r=>r.key===row.key&&r.state==='ORIGINAL_REVERTED'))
      throw new Error('NONCE_RECOVERY_EVIDENCE_MISSING');
  return result;
}
export async function verifyCancellationSigner(r:NonceRecovery):Promise<void> {
  if(r.raw&&(await recoverTransactionAddress({serializedTransaction:r.raw as TransactionSerialized})).toLowerCase()!==r.sender.toLowerCase())
    throw new Error('NONCE_RECOVERY_SCOPE');
}
export function validateCancellationReceipt(r:NonceRecovery,receipt:DeliveryReceipt):void {
  if(receipt.transactionHash!==r.hash||receipt.status!=='success'||receipt.logs.length!==0)
    throw new Error('NONCE_RECOVERY_RECEIPT_MISMATCH');
}
export const originalWon=(r:NonceRecovery):boolean=>r.state==='ORIGINAL_FINALIZED'||r.state==='ORIGINAL_REVERTED';
export const recoveryTerminal=(r:NonceRecovery):boolean=>r.state==='FINALIZED'||originalWon(r);
export const cancellationCount=(rows:NonceRecovery[]):number=>rows.filter(r=>r.cancellationReserved!==false).length;
/** Revalidate a retained original-winner proof using the immutable signed packet. */
export async function validateOriginalRecovery(r:NonceRecovery,receipt:DeliveryReceipt,block:{number:bigint;hash:Hex;timestamp:bigint},packet:StoredPacket|null):Promise<void>{
  const old=JSON.parse(r.originalBody);
  if(!originalWon(r)||!packet?.signature||packet.state!=='SIGNED'||packet.digest!==old.digest
    ||submitCalldata(packet.packet.observation,packet.signature).toLowerCase()!==old.request.data
    ||(await recoverAddress({hash:packet.digest,signature:packet.signature})).toLowerCase()!==packet.packet.domain.signer.toLowerCase()
    ||receipt.transactionHash!==old.txHash||receipt.blockNumber!==block.number||receipt.blockHash!==block.hash
    ||json(receipt)!==json(r.receipt))throw new Error('NONCE_RECOVERY_CANONICAL_MISMATCH');
  if(r.state==='ORIGINAL_REVERTED'){
    if(receipt.status!=='reverted'||receipt.logs.length!==0)throw new Error('NONCE_RECOVERY_RECEIPT_MISMATCH');
  }else if(json(validateReceipt(packet.packet,old.txHash,receipt,block,{depthNLots:BigInt(r.depthRule!.depthNLots),maxSpreadWad:BigInt(r.depthRule!.maxSpreadWad)}))!==json(r.originalAccepted))
    throw new Error('NONCE_RECOVERY_RECEIPT_MISMATCH');
}
export function recoveryBudget(db:DatabaseSync):{count:number;reservedWei:bigint} {
  const rows=nonceRecoveries(db);return {count:cancellationCount(rows),reservedWei:rows.reduce((s,r)=>s+BigInt(r.reservationWei),0n)};
}
export function saveRecovery(db:DatabaseSync,r:NonceRecovery):void {
  const body=json(r);db.prepare('INSERT INTO nonce_recoveries VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,sha256=excluded.sha256')
    .run(r.key,body,policyHash(body));
}
