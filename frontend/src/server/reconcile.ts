import type { Hex } from "viem";
import { client } from "@/lib/public-client";
import { db } from "./store";
import { privy } from "./privy";

/** Read-only network recovery: never resends a transaction or clears an unknown request. */
export async function reconcileRequest(id: string, transactionId: string) {
  const row = db().prepare("SELECT wallet,status FROM requests WHERE id=?").get(id) as { wallet: string; status: string } | undefined;
  if (!row || !["sending", "uncertain"].includes(row.status)) throw new Error("No unresolved request with this ID.");
  const transaction = await privy().transactions().get(transactionId);
  if (transaction.reference_id !== id || transaction.wallet_id !== row.wallet || transaction.caip2 !== "eip155:10143") throw new Error("Privy transaction does not match this exact request, wallet and chain.");
  if (!transaction.transaction_hash || !["confirmed", "finalized", "execution_reverted"].includes(transaction.status)) throw new Error("The original transaction has no final receipt yet. Keep the wallet paused.");
  if (await client.getChainId() !== 10143) throw new Error("Wrong RPC network.");
  const hash = transaction.transaction_hash as Hex;
  const receipt = await client.getTransactionReceipt({ hash });
  db().prepare("UPDATE requests SET status='sent',hash=? WHERE id=? AND status IN ('sending','uncertain')").run(hash, id);
  return { hash, status: receipt.status };
}
