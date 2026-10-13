const active = new Set<string>();

/** A funding sequence and a ticket must not send competing calls from the same wallet. */
export function lockWalletTransaction(chainId: number, owner: string): () => void {
  const key = `${chainId}:${owner.toLowerCase()}`;
  if (active.has(key)) throw new Error("Another transaction is already in progress for this wallet. Wait for its result before continuing.");
  active.add(key);
  return () => { active.delete(key); };
}
