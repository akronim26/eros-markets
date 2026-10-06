import type { Address, Hash, Hex, PublicClient, TransactionReceipt } from "viem";

type FinalityClient = Pick<PublicClient, "waitForTransactionReceipt" | "getTransactionReceipt" | "getBlock">;
type ReceiptClient = FinalityClient & Pick<PublicClient, "getTransaction">;
type Options = { timeoutMs?: number; pollMs?: number };

/** Inclusion is not finality. Re-read the receipt and its canonical block after finalization. */
export async function canonicalFinalizedReceipt(client: FinalityClient, hash: Hash, options: Options = {}): Promise<TransactionReceipt> {
  const timeout = options.timeoutMs ?? 180000;
  const deadline = Date.now() + timeout;
  const included = await client.waitForTransactionReceipt({ hash, timeout });
  if (included.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("The transaction was replaced. Review its result before continuing.");
  while ((await client.getBlock({ blockTag: "finalized" })).number < included.blockNumber) {
    if (Date.now() >= deadline) throw new Error("Transaction included; finality is still pending. Review the transaction before retrying.");
    await new Promise((done) => setTimeout(done, options.pollMs ?? 500));
  }
  const [receipt, block] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getBlock({ blockNumber: included.blockNumber }),
  ]);
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.blockNumber !== included.blockNumber
    || receipt.blockHash !== included.blockHash || block.hash !== receipt.blockHash || receipt.status !== included.status)
    throw new Error("Transaction identity or canonical block changed. Remaining steps were stopped.");
  return receipt;
}

/** Confirm the exact owner call at a canonical finalized block before a dependent call. */
export async function finalizedOwnerReceipt(client: ReceiptClient, hash: Hash,
  expected: { owner: Address; to: Address; data: Hex }, options: Options = {}): Promise<TransactionReceipt> {
  const receipt = await canonicalFinalizedReceipt(client, hash, options);
  if (receipt.status !== "success") throw new Error(`Transaction reverted in block ${receipt.blockNumber}.`);
  const transaction = await client.getTransaction({ hash });
  if (transaction.hash.toLowerCase() !== hash.toLowerCase() || transaction.blockHash !== receipt.blockHash
    || transaction.blockNumber !== receipt.blockNumber || transaction.from.toLowerCase() !== expected.owner.toLowerCase()
    || transaction.to?.toLowerCase() !== expected.to.toLowerCase()
    || transaction.input.toLowerCase() !== expected.data.toLowerCase() || transaction.value !== 0n)
    throw new Error("Transaction identity or canonical block changed. Remaining steps were stopped.");
  return receipt;
}
