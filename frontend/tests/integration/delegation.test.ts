import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expectedPolicy, delegatedEngines } from "../../src/server/policy";
import { privy } from "../../src/server/privy";
import { delegatedTrade } from "../../src/server/trade";
import { processProtectionBlock } from "../../src/server/automation";
import { client } from "../../src/lib/public-client";
import { reconcileRequest } from "../../src/server/reconcile";
import { db } from "../../src/server/store";

// SDK/chain doubles exercise the actual server paths. This is not a live Privy policy test.
const directory = mkdtempSync(join(tmpdir(), "eros-signing-tests-"));
Object.assign(process.env, { AUTOMATION_DB: join(directory, "test.sqlite"), NEXT_PUBLIC_PRIVY_APP_ID: "local-test-app", PRIVY_APP_SECRET: "test-only",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: "test-trade-key", PRIVY_TRADE_SIGNER_ID: "trade-signer", PRIVY_POLICY_TRADE_ID: "trade-policy",
  PRIVY_PROTECT_AUTHORIZATION_PRIVATE_KEY: "test-protect-key", PRIVY_PROTECT_SIGNER_ID: "protect-signer", PRIVY_POLICY_PROTECT_ID: "protect-policy" });
after(() => { db().close(); rmSync(directory, { recursive: true, force: true }); });
const address = "0x1111111111111111111111111111111111111111", engine = delegatedEngines[0];
const now = BigInt(Math.floor(Date.now() / 1000));
let revoked = false, badPolicy = false, failSend = false, sends = 0;
const calls: any[] = [];
const sdk = privy();
(sdk.users() as any)._get = async (id: string) => ({ linked_accounts: id === "alice" ? [{ type: "wallet", chain_type: "ethereum", wallet_client_type: "privy", address, id: "alice-wallet" }] : [] });
(sdk.wallets() as any).get = async () => ({ id: "alice-wallet", address, chain_type: "ethereum", additional_signers: revoked ? [] : [{ signer_id: "trade-signer", override_policy_ids: ["trade-policy"] }, { signer_id: "protect-signer", override_policy_ids: ["protect-policy"] }] });
(sdk.policies() as any).get = async (id: string) => { const p = expectedPolicy(id === "trade-policy" ? "trade" : "protect"); if (badPolicy) p.rules[0].conditions = []; return p; };
(sdk.wallets().ethereum() as any).sendTransaction = async (id: string, request: any) => { sends++; calls.push({ id, request }); if (failSend) throw new Error("network ambiguity"); return { hash: `0x${String(sends).padStart(64, "0")}` }; };
Object.assign(client, { getChainId: async () => 10143, getBlock: async () => ({ number: 1000n, timestamp: now }), getBalance: async () => 10n ** 18n, getGasPrice: async () => 1n, call: async () => ({ data: "0x" }), estimateGas: async () => 100000n,
  readContract: async (c: any) => c.functionName === "participantId" ? 1 : c.functionName === "maxFills" ? 8 : c.functionName === "previewAccount" ? { positionLots: 1000n } : c.functionName === "getOrder" ? { owner: 2 } : { rejection: 0, acceptedCapLots: 1000n },
  multicall: async () => [{ markAvailable: true, markWad: 390000000000000000n, secsToT: 80000n, monitorRestricted: false, stage: 0 }, { positionLots: 1000n, status: 1, e0Q: 1n, e1Q: 1n }, 8, 0n, { halted: false, claimsEnabled: false }, { deploymentCapX: 1n }],
  waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 1001n, logs: [] }),
});
const intent = () => ({ wallet: address, engine, previewBlock: "1000", clientNonce: randomUUID(), action: "placeOrder", place: { kind: 1, isBuy: false, reduceOnly: true, tick: 380, size: "1000", maxFills: 8, expiryBlock: 0 } });
test("server sends only from the authenticated owner's wallet, with exact order, chain, gas and persisted idempotency", async () => {
  const input = intent();
  const hash = await delegatedTrade("alice", input);
  assert.equal(await delegatedTrade("alice", input), hash); assert.equal(sends, 1);
  assert.equal(calls[0].id, "alice-wallet");
  assert.equal(calls[0].request.params.transaction.from, address); assert.equal(calls[0].request.params.transaction.to, engine);
  assert.equal(calls[0].request.caip2, "eip155:10143"); assert.equal(calls[0].request.params.transaction.gas_limit, "0x1adb0");
  await assert.rejects(delegatedTrade("bob", intent()), /does not belong/);
  await assert.rejects(delegatedTrade("alice", { ...input, place: { ...input.place, tick: 379 } }), /different order/);
  await assert.rejects(delegatedTrade("alice", { ...intent(), action: "cancel", place: undefined, orderId: 9 }), /Unexpected request field/);
});
test("revoked grants, widened policies, stale previews and reversed protection never sign", async () => {
  const before = sends;
  revoked = true; await assert.rejects(delegatedTrade("alice", intent()), /revoked/); revoked = false;
  badPolicy = true; await assert.rejects(delegatedTrade("alice", intent()), /restrictions/); badPolicy = false;
  await assert.rejects(delegatedTrade("alice", { ...intent(), previewBlock: "10" }), /stale/);
  const input = intent(); await assert.rejects(delegatedTrade("alice", { ...input, place: { ...input.place, isBuy: true } }, "protect"), /cannot add/);
  assert.equal(sends, before);
});
test("a triggered rule submits once, records its actual receipt, and never repeats an empty IOC", async () => {
  const id = randomUUID(), before = sends;
  db().prepare("INSERT INTO rules(id,user,wallet,engine,body,status,created) VALUES (?,?,?,?,?,'active',?)").run(id, "alice", address, engine, JSON.stringify({ kind: "stop_loss", triggerTick: 400, limitTick: 380, maxLots: "1000", long: true, expires: Number(now) + 3600 }), Date.now());
  await processProtectionBlock(); await processProtectionBlock();
  assert.equal(sends, before + 1);
  const row = db().prepare("SELECT status,message FROM rules WHERE id=?").get(id) as any;
  assert.equal(row.status, "completed"); assert.match(row.message, /0 lots filled/);
  assert.equal((db().prepare("SELECT count(*) AS n FROM journal WHERE rule_id=?").get(id) as { n: number }).n, 2);
});
test("ambiguous signing blocks duplicate and subsequent sends until reconciliation", async () => {
  const input = intent(); failSend = true;
  await assert.rejects(delegatedTrade("alice", input), /did not confirm/);
  const before = sends; failSend = false;
  await assert.rejects(delegatedTrade("alice", input), /already submitted/);
  await assert.rejects(delegatedTrade("alice", intent()), /reconciliation/);
  assert.equal(sends, before);
});

test("reconciliation only releases the wallet after the exact Privy reference has a chain receipt", async () => {
  const row = db().prepare("SELECT id FROM requests WHERE status='uncertain'").get() as { id: string };
  const hash = `0x${"ab".repeat(32)}`;
  let reference = "different-request";
  (sdk.transactions() as any).get = async () => ({ reference_id: reference, wallet_id: "alice-wallet", caip2: "eip155:10143", transaction_hash: hash, status: "confirmed" });
  await assert.rejects(reconcileRequest(row.id, "tx-id"), /does not match/);
  assert.equal((db().prepare("SELECT status FROM requests WHERE id=?").get(row.id) as any).status, "uncertain");
  reference = row.id;
  Object.assign(client, { getTransactionReceipt: async () => ({ status: "success" }) });
  const before = sends;
  assert.deepEqual(await reconcileRequest(row.id, "tx-id"), { hash, status: "success" });
  assert.equal(sends, before);
  assert.equal((db().prepare("SELECT status FROM requests WHERE id=?").get(row.id) as any).status, "sent");
});
