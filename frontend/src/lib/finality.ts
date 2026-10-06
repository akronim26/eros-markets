import type { Address, Hash, Hex, PublicClient, TransactionReceipt } from "viem";

type ReceiptClient = Pick<PublicClient, "waitForTransactionReceipt" | "getBlock" | "getTransaction">;

/** Confirm the exact owner call at a canonical finalized block before a dependent call. */
export async function finalizedOwnerReceipt(client: ReceiptClient, hash: Hash,
  expected: { owner: Address; to: Address; data: Hex }, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<TransactionReceipt> {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: options.timeoutMs ?? 180000 });
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("The transaction was replaced. Review its result before continuing.");
  if (receipt.status !== "success") throw new Error(`Transaction reverted in block ${receipt.blockNumber}.`);
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  while ((await client.getBlock({ blockTag: "finalized" })).number < receipt.blockNumber) {
    if (Date.now() >= deadline) throw new Error("Transaction included; finality is still pending. Review the transaction before retrying.");
    await new Promise((done) => setTimeout(done, options.pollMs ?? 500));
  }
  const [block, transaction] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash }),
  ]);
  if (block.hash !== receipt.blockHash || transaction.blockHash !== receipt.blockHash
    || transaction.from.toLowerCase() !== expected.owner.toLowerCase()
    || transaction.to?.toLowerCase() !== expected.to.toLowerCase()
    || transaction.input.toLowerCase() !== expected.data.toLowerCase() || transaction.value !== 0n)
    throw new Error("Transaction identity or canonical block changed. Remaining steps were stopped.");
  return receipt;
}
