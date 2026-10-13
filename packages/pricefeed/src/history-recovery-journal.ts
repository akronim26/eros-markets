import type { DatabaseSync } from 'node:sqlite';
import { policyHash } from './relay-policy.js';

/** Reviewed stale-view recovery is an append-only transition, never a journal reset. */
export function verifyHistoryRecoveryAudit(db:DatabaseSync,sender?:string):void {
  const control=db.prepare('SELECT * FROM relay_control WHERE id=1').get();
  const revision=Number(control?.history_revision??0);
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE name='relay_history_recovery_audit'").get();
  const rows=exists?db.prepare('SELECT revision,approval_hash,body,sha256 FROM relay_history_recovery_audit ORDER BY revision').all():[];
  if(!Number.isSafeInteger(revision)||revision<0||rows.length!==revision)throw Error('HISTORY_RECOVERY_AUDIT_INTEGRITY');
  let previous:string|null=null;
  for(let i=0;i<rows.length;i++){
    const row=rows[i]!,body=String(row.body),entry=JSON.parse(body);
    if(Number(row.revision)!==i+1||entry.revision!==i+1||policyHash(body)!==row.sha256
      ||entry.previousHash!==previous||entry.reason!=='SIGNED_SOURCE_HISTORY_MISMATCH'
      ||entry.mode!=='MONAD_TESTNET_FINALIZED_VIEW_RECOVERY'||entry.chainId!==10143
      ||!/^0x[\da-f]{40}$/i.test(entry.sender??'')||sender&&entry.sender.toLowerCase()!==sender.toLowerCase()
      ||!/^[\da-f]{64}$/.test(entry.approvalHash??'')||entry.approvalHash!==row.approval_hash||!/^[\da-f]{64}$/.test(entry.journalHashBefore??'')
      ||!entry.lagEvidence||BigInt(entry.lagEvidence.snapshotBlock)>=BigInt(entry.lagEvidence.acceptedBlock))
      throw Error('HISTORY_RECOVERY_AUDIT_INTEGRITY');
    previous=String(row.sha256);
  }
}
