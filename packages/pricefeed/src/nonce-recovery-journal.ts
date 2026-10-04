import type { DatabaseSync } from 'node:sqlite';
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { policyHash } from './relay-policy.js';
import { json } from './math.js';
import type { DeliveryReceipt } from './receipts.js';

export type NonceRecovery={key:string;sender:Hex;nonce:string;originalBody:string;originalSha256:string;
  request:{gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string};
  raw:Hex|null;hash:Hex|null;state:'PREPARING'|'READY'|'UNKNOWN'|'FINALIZED';attempts:number;
  receipt:DeliveryReceipt|null;reservationWei:string;profile:string;signerJournalId:string};

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
      ||r.reservationWei!==(21000n*BigInt(r.request.maxFeePerGas)).toString()
      ||!['PREPARING','READY','UNKNOWN','FINALIZED'].includes(r.state)||!Number.isSafeInteger(r.attempts)||r.attempts<0)
      throw new Error('NONCE_RECOVERY_INTEGRITY');
    const old=JSON.parse(r.originalBody),current=db.prepare('SELECT body,sha256 FROM deliveries WHERE key=?').get(r.key);
    if(!current||policyHash(String(current.body))!==current.sha256)throw new Error('NONCE_RECOVERY_INTEGRITY');
    const delivery=JSON.parse(String(current.body));
    if(old.state!=='QUARANTINED'||old.attempts!==0||old.nonce!==r.nonce||!old.raw||old.accepted!==null
      ||!['RELAY_HEADROOM_EXPIRED','RESERVED_NONCE_HEADROOM_EXPIRED'].includes(old.reason)
      ||json({...delivery,state:old.state,reason:old.reason})!==r.originalBody
      ||delivery.state!==(r.state==='FINALIZED'?'CANCELLED':'QUARANTINED')
      ||r.state==='FINALIZED'&&delivery.reason!=='NONCE_CANCELLED')throw new Error('NONCE_RECOVERY_INTEGRITY');
    if(r.raw){
      const tx=parseTransaction(r.raw);
      if(keccak256(r.raw)!==r.hash||tx.type!=='eip1559'||tx.chainId!==10143||tx.nonce!==Number(r.nonce)
        ||tx.to?.toLowerCase()!==r.sender.toLowerCase()||(tx.value??0n)!==0n||(tx.data??'0x')!=='0x'
        ||tx.gas!==21000n||tx.maxFeePerGas!==BigInt(r.request.maxFeePerGas)
        ||tx.maxPriorityFeePerGas!==BigInt(r.request.maxPriorityFeePerGas))throw new Error('NONCE_RECOVERY_SCOPE');
    }else if(r.hash||r.state!=='PREPARING'||r.attempts!==0)throw new Error('NONCE_RECOVERY_INTEGRITY');
    if(r.state==='FINALIZED'){if(!r.receipt||!r.hash)throw new Error('NONCE_RECOVERY_INTEGRITY');validateCancellationReceipt(r,r.receipt);}
    else if(r.receipt!==null)throw new Error('NONCE_RECOVERY_INTEGRITY');
    result.push(r);
  }
  for(const row of db.prepare('SELECT key,body FROM deliveries').all())
    if(JSON.parse(String(row.body)).state==='CANCELLED'&&!result.some(r=>r.key===row.key&&r.state==='FINALIZED'))
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
export function recoveryBudget(db:DatabaseSync):{count:number;reservedWei:bigint} {
  const rows=nonceRecoveries(db);return {count:rows.length,reservedWei:rows.reduce((s,r)=>s+BigInt(r.reservationWei),0n)};
}
export function saveRecovery(db:DatabaseSync,r:NonceRecovery):void {
  const body=json(r);db.prepare('INSERT INTO nonce_recoveries VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,sha256=excluded.sha256')
    .run(r.key,body,policyHash(body));
}
