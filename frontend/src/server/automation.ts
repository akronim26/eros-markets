import { createWalletClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { engineAbi } from "@/abi/engine";
import { chain, RPC_URL } from "@/config/chain";
import { client } from "@/lib/public-client";
import { protectionDecision, type ProtectionRule } from "@/lib/protection";
import { db } from "./store";
import { delegatedTrade } from "./trade";
import { configured, ownedWallet } from "./privy";
import { canonicalFinalizedReceipt } from "@/lib/finality";
import { ensureDeployment } from "@/lib/deployment-check";
import { marketByEngine } from "@/config/deployment";

type StoredRule = { id: string; user: string; wallet: Address; engine: Address; body: string; status: string };
export async function processProtectionBlock() {
  if (!configured("protect")) throw new Error("Protection credentials are missing or share the trade signing key.");
  await ensureDeployment();
  const head = await client.getBlock();
  if (await client.getChainId() !== 10143 || Date.now() / 1000 - Number(head.timestamp) > 30) throw new Error("Chain head is stale or on the wrong network.");
  db().prepare("INSERT INTO service VALUES ('heartbeat',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(Date.now());
  const rows = db().prepare("SELECT * FROM rules WHERE status='active' ORDER BY checked,id LIMIT 100").all() as StoredRule[];
  for (const row of rows) {
    try {
      const rule = JSON.parse(row.body) as ProtectionRule;
      if (!marketByEngine(row.engine)) throw new Error("Rule market is not in the verified deployment");
      db().prepare("UPDATE rules SET checked=? WHERE id=?").run(Date.now(), row.id);
      const head = await client.getBlock();
      if (Date.now() / 1000 - Number(head.timestamp) > 30) throw new Error("Stale chain head");
      const trader = await client.readContract({ address: row.engine, abi: engineAbi, functionName: "participantId", args: [row.wallet], blockNumber: head.number });
      const [risk, account, maxFills, claimable, settlement, listing] = await client.multicall({ blockNumber: head.number, allowFailure: false, contracts: [
        { address: row.engine, abi: engineAbi, functionName: "marketRiskView" }, { address: row.engine, abi: engineAbi, functionName: "previewAccount", args: [trader] },
        { address: row.engine, abi: engineAbi, functionName: "maxFills" }, { address: row.engine, abi: engineAbi, functionName: "claimableAtoms", args: [row.wallet] },
        { address: row.engine, abi: engineAbi, functionName: "getSettlementStatus" }, { address: row.engine, abi: engineAbi, functionName: "listing" },
      ] });
      const decision = protectionDecision(rule, { now: head.timestamp, markAvailable: risk.markAvailable, markWad: risk.markWad, lots: account.positionLots, status: account.status, e0: account.e0Q, e1: account.e1Q, secsToT: risk.secsToT, monitorRestricted: risk.monitorRestricted, stage: risk.stage, halted: settlement.halted, leveraged: listing.deploymentCapX > 1n, claimable: settlement.claimsEnabled && !settlement.recoveryRequired ? claimable : 0n });
      if (decision === "wait") continue;
      if (decision === "expired" || decision === "done") { db().prepare("UPDATE rules SET status='completed',message=? WHERE id=? AND status='active'").run(decision === "expired" ? "Rule expired" : "Position closed, reversed, or market halted", row.id); continue; }
      let size = BigInt(rule.maxLots), position = account.positionLots < 0n ? -account.positionLots : account.positionLots;
      if (size > position) size = position;
      if (decision === "reduce") {
        const preview = await client.readContract({ address: row.engine, abi: engineAbi, functionName: "previewOrder", args: [trader, account.positionLots < 0n ? 0 : 1, rule.limitTick, size, true], blockNumber: head.number });
        if (preview.rejection || !preview.acceptedCapLots) { db().prepare("UPDATE rules SET message=? WHERE id=?").run("Trigger reached; no admitted reduction at the chosen limit. Waiting.", row.id); continue; }
        if (size > preview.acceptedCapLots) size = preview.acceptedCapLots;
      }
      // Atomic claim: a second worker or an owner cancellation cannot execute the same active rule.
      const claimed = db().prepare("UPDATE rules SET status='sending',message='Trigger reached; submitting once' WHERE id=? AND status='active'").run(row.id);
      if (!claimed.changes) continue;
      db().prepare("INSERT INTO journal(rule_id,block,message,created) VALUES (?,?,?,?)").run(row.id, head.number.toString(), `Trigger: ${decision}`, Date.now());
      let hash: Hex;
      if (decision === "claim") {
        if (!process.env.CLAIM_DELIVERY_PRIVATE_KEY) throw new Error("Claim delivery signer unavailable");
        await ownedWallet(row.user, row.wallet);
        const payer = privateKeyToAccount(process.env.CLAIM_DELIVERY_PRIVATE_KEY as Hex);
        const call = { address: row.engine, abi: engineAbi, functionName: "claimTrader", args: [row.wallet], account: payer } as const;
        const sim = await client.simulateContract({ ...call, blockNumber: head.number }), gas = (await client.estimateContractGas({ ...call, blockNumber: head.number }) * 110n + 99n) / 100n;
        if (gas > 30000000n || (await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error("Claim simulation is no longer valid");
        hash = await createWalletClient({ account: payer, chain, transport: http(RPC_URL) }).writeContract({ ...sim.request, gas });
      } else hash = await delegatedTrade(row.user, { wallet: row.wallet, engine: row.engine, clientNonce: row.id, previewBlock: head.number.toString(), action: decision === "cancel" ? "cancelAll" : "placeOrder",
        ...(decision === "reduce" ? { place: { kind: 1, isBuy: account.positionLots < 0n, reduceOnly: true, tick: rule.limitTick, size: size.toString(), maxFills, expiryBlock: Number(head.number + 150n) } } : {}) }, "protect");
      db().prepare("UPDATE rules SET hash=?,message='Broadcast; awaiting confirmation' WHERE id=?").run(hash, row.id);
      const receipt = await canonicalFinalizedReceipt(client, hash, { timeoutMs: 60000 });
      const fills = parseEventLogs({ abi: engineAbi, eventName: "Fill", logs: receipt.logs.filter((l) => l.address.toLowerCase() === row.engine) });
      const filled = fills.filter((l) => l.args.taker === trader).reduce((n, l) => n + l.args.size, 0n);
      const message = receipt.status === "reverted" ? "Transaction reverted; rule stopped" : decision === "reduce" ? `Confirmed IOC: ${filled} lots filled; any remainder was cancelled. Rule completed.` : `${decision} confirmed`;
      db().prepare("UPDATE rules SET status=?,message=? WHERE id=?").run(receipt.status === "success" ? "completed" : "failed", message, row.id);
      db().prepare("INSERT INTO journal(rule_id,block,message,hash,created) VALUES (?,?,?,?,?)").run(row.id, receipt.blockNumber.toString(), message, hash, Date.now());
    } catch {
      // Sending is never retried blindly: the request may already have reached Privy or the chain.
      db().prepare("UPDATE rules SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE status END,message=? WHERE id=?").run("Read, permission, simulation or receipt check failed. Check wallet activity before replacing this rule.", row.id);
    }
  }
}
