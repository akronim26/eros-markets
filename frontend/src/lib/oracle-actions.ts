export const ORACLE_ACTIONS = [
  ["haltScheduled", "Record scheduled halt"], ["requestResolution", "Request data check"],
  ["escalateToL2", "Move to model panel"], ["openAfterDeadline", "Open public proposals"],
  ["assertProposal", "Post recorded proposal"], ["syncAssertion", "Sync dispute"],
  ["finalizeMarket", "Finalize outcome"], ["voidMarket", "Resolve overdue market as INVALID"],
  ["expireEarly", "Expire early check"],
] as const;

export function validEvidence(uri: string, hash: string) {
  return /^(https:\/\/|ipfs:\/\/)/.test(uri) && new TextEncoder().encode(uri).length <= 256
    && /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0+$/.test(hash);
}
export function canDispute(a: { exists: boolean; disputed: boolean; settled: boolean; expiresAt: bigint }, now: bigint) {
  return a.exists && !a.disputed && !a.settled && now < a.expiresAt;
}
