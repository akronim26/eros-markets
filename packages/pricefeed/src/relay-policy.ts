import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RelayPolicy } from './durable-relay.js';
import { json } from './math.js';

export type RelayProfile={chainId:31337n|10143n;maxTransactions?:number;totalMaxCostWei?:bigint;budgetRevision?:number};
export const policyHash=(body:string)=>createHash('sha256').update(body).digest('hex');
export function relayProfileBody(profile:RelayProfile,policy:RelayPolicy):string {
  const canonical={gasCap:policy.gasCap,maxFeePerGas:policy.maxFeePerGas,maxPriorityFeePerGas:policy.maxPriorityFeePerGas,
    maxCostWei:policy.maxCostWei,headroomMs:policy.headroomMs,confirmations:policy.confirmations,leaseMs:policy.leaseMs,
    timeoutMs:policy.timeoutMs,maxAttempts:policy.maxAttempts,
    ...(policy.gasSafetyMarginBps!==undefined?{gasSafetyMarginBps:policy.gasSafetyMarginBps}:{})};
  return json(profile.chainId===10143n?{...profile,relayPolicy:canonical}:profile);
}
/** A revisioned policy requires its complete, ordered, checksum-bound transition history. */
export function verifyBudgetAudit(db:DatabaseSync,profileBody:string,revision=0):void {
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_budget_audit'").get();
  const rows=exists?db.prepare('SELECT revision,body,sha256 FROM relay_budget_audit ORDER BY revision').all():[];
  if(rows.length!==revision)throw new Error('BUDGET_AUDIT_INTEGRITY');
  let previousHash:string|null=null,previousProfile:string|undefined;
  for(let i=0;i<rows.length;i++){
    const row=rows[i]!,body=String(row.body),entry=JSON.parse(body);
    if(Number(row.revision)!==i+1||policyHash(body)!==row.sha256||entry.revision!==i+1
      ||entry.previousHash!==previousHash||previousProfile!==undefined&&entry.fromProfile!==previousProfile
      ||JSON.parse(entry.toProfile).budgetRevision!==i+1)throw new Error('BUDGET_AUDIT_INTEGRITY');
    previousHash=String(row.sha256);previousProfile=entry.toProfile;
  }
  if(previousProfile!==undefined&&previousProfile!==profileBody)throw new Error('BUDGET_AUDIT_INTEGRITY');
}
