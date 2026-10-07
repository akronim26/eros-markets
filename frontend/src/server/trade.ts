import { PublicError, publicErrorMessage } from "@/lib/public-error";
import { createHash } from "node:crypto";
import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "@/lib/public-client";
import { validateIntent } from "@/lib/delegated-intent";
import { delegatedEngines, type SignerMode } from "./policy";
import { ownedWallet, privy, signingWallet } from "./privy";
import { db } from "./store";
import { ensureDeployment } from "@/lib/deployment-check";
import { marketByEngine } from "@/config/deployment";

export class TradeDeliveryError extends Error {
  constructor(readonly delivery: "rejected" | "pending" | "unknown", readonly original: unknown) {
    super(publicErrorMessage(original, "Trading request failed. Recover its status before retrying."));
  }
}

export async function delegatedTrade(user: string, input: unknown, mode: SignerMode = "trade") {
  const intent = validateIntent(input, delegatedEngines, mode === "protect");
  // Recover an owned request even after its additional signer has been revoked.
  // Current signing authority is required only for a new send.
  const wallet = await ownedWallet(user, intent.wallet);
  const digest = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
  const id = createHash("sha256").update(`${user}:${wallet.id}:${intent.clientNonce}`).digest("hex");
  const prior = () => {
    const existing = db().prepare("SELECT * FROM requests WHERE id=?").get(id) as { digest: string; status: string; hash?: Hex } | undefined;
    if (!existing) return;
    if (existing.digest !== digest) throw new TradeDeliveryError("unknown", new PublicError("Request ID already used for a different order."));
    if (existing.hash) return existing.hash;
    if (existing.status === "rejected") throw new TradeDeliveryError("rejected", new PublicError("This request was rejected before signing. Review the order and submit a new request."));
    throw new TradeDeliveryError("pending", new PublicError("This request is still pending or uncertain. Recover this request before starting another order."));
  };
  const existing = prior();
  if (existing) return existing;
  // Claim before asynchronous preflight. Another copy cannot validate in parallel
  // and later send after this copy has been declared definitively rejected.
  db().exec("BEGIN IMMEDIATE");
  try {
    const raced = prior();
    if (raced) { db().exec("COMMIT"); return raced; }
    if (db().prepare("SELECT id FROM requests WHERE wallet=? AND status IN ('sending','uncertain')").get(wallet.id))
      throw new TradeDeliveryError("pending", new PublicError("A prior wallet request needs reconciliation before another can be sent."));
    db().prepare("INSERT INTO requests(id,wallet,digest,status,created) VALUES (?,?,?,'sending',?)").run(id, wallet.id, digest, Date.now());
    db().exec("COMMIT");
  } catch (error) { db().exec("ROLLBACK"); throw error; }
  let sending = false;
  try {
    await signingWallet(user, intent.wallet, mode);
    const market = marketByEngine(intent.engine);
    if (!market) throw new PublicError("This market is not in the verified deployment.");
    if (market.archived && intent.action === "placeOrder" && !intent.place.reduceOnly) throw new PublicError("Archived markets accept position reductions only.");
    await ensureDeployment();
    const head = await client.getBlock();
    if (await client.getChainId() !== 10143 || Math.abs(Date.now() / 1000 - Number(head.timestamp)) > 30 || BigInt(intent.previewBlock) > head.number || head.number - BigInt(intent.previewBlock) > 150n) throw new PublicError("Market preview is stale. Refresh and try again.");
    const account = wallet.address as Address, engine = intent.engine as Address;
    const trader = await client.readContract({ address: engine, abi: engineAbi, functionName: "participantId", args: [account], blockNumber: head.number });
    if (!trader) throw new PublicError("Fund this wallet's market account first.");
    let data: Hex;
    if (intent.action === "placeOrder") {
      const p = { ...intent.place, size: BigInt(intent.place.size) };
      const [preview, maxFills, position] = await Promise.all([
        client.readContract({ address: engine, abi: engineAbi, functionName: "previewOrder", args: [trader, p.isBuy ? 0 : 1, p.tick, p.size, p.reduceOnly], blockNumber: head.number }),
        client.readContract({ address: engine, abi: engineAbi, functionName: "maxFills", blockNumber: head.number }),
        client.readContract({ address: engine, abi: engineAbi, functionName: "previewAccount", args: [trader], blockNumber: head.number }),
      ]);
      if (p.maxFills > maxFills || (p.expiryBlock && BigInt(p.expiryBlock) <= head.number)) throw new PublicError("Order bounds changed. Refresh and try again.");
      if (mode === "protect" && (p.size > (position.positionLots < 0n ? -position.positionLots : position.positionLots) || p.isBuy !== (position.positionLots < 0n))) throw new PublicError("Protection cannot add exposure or reverse a position.");
      if (preview.rejection || preview.acceptedCapLots < p.size) throw new PublicError("The latest preview does not admit this exact size. Review the order.");
      data = encodeFunctionData({ abi: engineAbi, functionName: "placeOrder", args: [p] });
    } else if (intent.action === "cancel") {
      const order = await client.readContract({ address: engine, abi: engineAbi, functionName: "getOrder", args: [intent.orderId], blockNumber: head.number });
      if (order.owner !== trader) throw new PublicError("This order belongs to another account.");
      data = encodeFunctionData({ abi: engineAbi, functionName: "cancel", args: [intent.orderId] });
    } else data = encodeFunctionData({ abi: engineAbi, functionName: "cancelAll" });
    await client.call({ account, to: engine, data, blockNumber: head.number });
    const gas = (await client.estimateGas({ account, to: engine, data, blockNumber: head.number }) * 110n + 99n) / 100n;
    if (gas > 30000000n) throw new PublicError("The transaction exceeds the supported gas limit.");
    const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account }), client.getGasPrice()]);
    if (balance < gas * gasPrice) throw new PublicError("Not enough testnet MON for gas.");
    // Check revocation again immediately before requesting a signature.
    const { config } = await signingWallet(user, intent.wallet, mode);
    if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new PublicError("The preview block changed. Refresh before trading.");
    sending = true;
    const result = await privy().wallets().ethereum().sendTransaction(wallet.id, { caip2: "eip155:10143", idempotency_key: id, reference_id: id,
      authorization_context: { authorization_private_keys: [config.key!] }, params: { transaction: { from: account, to: engine, data, value: "0x0", chain_id: 10143, gas_limit: toHex(gas) } } });
    db().prepare("UPDATE requests SET status='sent',hash=? WHERE id=?").run(result.hash, id);
    return result.hash as Hex;
  } catch (error) {
    db().prepare("UPDATE requests SET status=? WHERE id=?").run(sending ? "uncertain" : "rejected", id);
    throw new TradeDeliveryError(sending ? "pending" : "rejected", sending
      ? new PublicError("Signing service did not confirm the result. Recover this request before starting another order.") : error);
  }
}
