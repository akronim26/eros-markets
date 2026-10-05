import { createHash } from "node:crypto";
import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "@/lib/public-client";
import { validateIntent } from "@/lib/delegated-intent";
import { delegatedEngines, type SignerMode } from "./policy";
import { privy, signingWallet } from "./privy";
import { db } from "./store";

export async function delegatedTrade(user: string, input: unknown, mode: SignerMode = "trade") {
  const intent = validateIntent(input, delegatedEngines, mode === "protect");
  const { wallet, config } = await signingWallet(user, intent.wallet, mode);
  const digest = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
  const id = createHash("sha256").update(`${user}:${wallet.id}:${intent.clientNonce}`).digest("hex");
  const existing = db().prepare("SELECT * FROM requests WHERE id=?").get(id) as { digest: string; status: string; hash?: Hex } | undefined;
  if (existing) {
    if (existing.digest !== digest) throw new Error("Request ID already used for a different order.");
    if (existing.hash) return existing.hash;
    throw new Error("This request was already submitted. Its status is uncertain; do not submit it again. Check wallet activity.");
  }
  if (db().prepare("SELECT id FROM requests WHERE wallet=? AND status IN ('sending','uncertain')").get(wallet.id)) throw new Error("A prior wallet request needs reconciliation before another can be sent.");
  const head = await client.getBlock();
  if (await client.getChainId() !== 10143 || Date.now() / 1000 - Number(head.timestamp) > 30 || BigInt(intent.previewBlock) > head.number || head.number - BigInt(intent.previewBlock) > 150n) throw new Error("Market preview is stale. Refresh and try again.");
  const account = wallet.address as Address, engine = intent.engine as Address;
  const trader = await client.readContract({ address: engine, abi: engineAbi, functionName: "participantId", args: [account], blockNumber: head.number });
  if (!trader) throw new Error("Fund this wallet's market account first.");
  let data: Hex;
  if (intent.action === "placeOrder") {
    const p = { ...intent.place, size: BigInt(intent.place.size) };
    const [preview, maxFills, position] = await Promise.all([
      client.readContract({ address: engine, abi: engineAbi, functionName: "previewOrder", args: [trader, p.isBuy ? 0 : 1, p.tick, p.size, p.reduceOnly], blockNumber: head.number }),
      client.readContract({ address: engine, abi: engineAbi, functionName: "maxFills", blockNumber: head.number }),
      client.readContract({ address: engine, abi: engineAbi, functionName: "previewAccount", args: [trader], blockNumber: head.number }),
    ]);
    if (p.maxFills > maxFills || (p.expiryBlock && BigInt(p.expiryBlock) <= head.number)) throw new Error("Order bounds changed. Refresh and try again.");
    if (mode === "protect" && (p.size > (position.positionLots < 0n ? -position.positionLots : position.positionLots) || p.isBuy !== (position.positionLots < 0n))) throw new Error("Protection cannot add exposure or reverse a position.");
    if (preview.rejection || preview.acceptedCapLots < p.size) throw new Error("The latest preview does not admit this exact size. Review the order.");
    data = encodeFunctionData({ abi: engineAbi, functionName: "placeOrder", args: [p] });
  } else if (intent.action === "cancel") {
    const order = await client.readContract({ address: engine, abi: engineAbi, functionName: "getOrder", args: [intent.orderId], blockNumber: head.number });
    if (order.owner !== trader) throw new Error("This order belongs to another account.");
    data = encodeFunctionData({ abi: engineAbi, functionName: "cancel", args: [intent.orderId] });
  } else data = encodeFunctionData({ abi: engineAbi, functionName: "cancelAll" });
  await client.call({ account, to: engine, data, blockNumber: head.number });
  const gas = await client.estimateGas({ account, to: engine, data }) * 110n / 100n;
  const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account }), client.getGasPrice()]);
  if (balance < gas * gasPrice) throw new Error("Not enough testnet MON for gas.");
  // Check revocation again immediately before requesting a signature.
  await signingWallet(user, intent.wallet, mode);
  db().exec("BEGIN IMMEDIATE");
  try {
    if (db().prepare("SELECT id FROM requests WHERE wallet=? AND status IN ('sending','uncertain')").get(wallet.id)) throw new Error("Another wallet request is in progress.");
    db().prepare("INSERT INTO requests(id,wallet,digest,status,created) VALUES (?,?,?,'sending',?)").run(id, wallet.id, digest, Date.now());
    db().exec("COMMIT");
  } catch (e) { db().exec("ROLLBACK"); throw e; }
  try {
    const result = await privy().wallets().ethereum().sendTransaction(wallet.id, { caip2: "eip155:10143", idempotency_key: id, reference_id: id,
      authorization_context: { authorization_private_keys: [config.key!] }, params: { transaction: { from: account, to: engine, data, value: "0x0", chain_id: 10143, gas_limit: toHex(gas) } } });
    db().prepare("UPDATE requests SET status='sent',hash=? WHERE id=?").run(result.hash, id);
    return result.hash as Hex;
  } catch {
    db().prepare("UPDATE requests SET status='uncertain' WHERE id=?").run(id);
    throw new Error("Signing service did not confirm the result. Check wallet activity before retrying; this request will not be sent twice.");
  }
}
