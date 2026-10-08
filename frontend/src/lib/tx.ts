"use client";

import { useRef, useState } from "react";
import { useConfig } from "wagmi";
import { getConnection, writeContract } from "wagmi/actions";
import { encodeFunctionData, parseEventLogs, type Abi, type Address, type Hash } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "./reads";
import { engineAbi } from "@/abi/engine";
import { REJECT, CANCEL_REASON } from "./enums";
import { lotsToClaims } from "./units";
import { chain } from "@/config/chain";
import { useWalletSession } from "@/components/wallet-session";
import { createWalletGuard, runWalletCalls } from "./wallet-safety";
import { privyRequest } from "./privy-api";
import { rememberOrders } from "./orders";
import { ensureDeployment } from "./deployment-check";
import { finalizedOwnerReceipt } from "./finality";
import { lockWalletTransaction } from "./transaction-lock";
import { markets } from "@/config/deployment";
import { DelegatedAttemptStore, assertAttemptBinding, confirmDelegatedAttempt, delegatedCall, recoverDelegatedAttempt, type DelegatedAttempt } from "./delegated-attempt";
import { validateIntent } from "./delegated-intent";
import { revertMessage } from "./transaction-errors";
export { revertMessage } from "./transaction-errors";

type TxPhase = "preflight" | "signature" | "confirmation" | "post-confirmation";
type CompletedStep = { hash: Hash; label: string };

export type TxState =
  | { status: "idle" }
  | { status: "pending"; step: string }
  | { status: "sent"; hash: Hash; step: string }
  | { status: "done"; hash: Hash; summary: string; tone: "bid" | "ask" | "neutral" }
  | { status: "error"; message: string; hash?: Hash; step?: string; phase?: TxPhase; completed?: CompletedStep[] };

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; label: string; account?: Address; chainId?: number; validate?: (block: bigint) => Promise<void> };
const delegatedEngines = markets.map(m => m.engine.toLowerCase());
const attempts = () => new DelegatedAttemptStore(window.sessionStorage, delegatedEngines, chain.id);

/** preview → simulate → explicit gas (estimate × 1.10, Monad charges the limit) → send → receipt. */
export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const { getSnapshot } = useWalletSession();
  const running = useRef(false);
  const [result, setResult] = useState<{ scope: string; state: TxState }>({ scope: "", state: { status: "idle" } });
  const current = getSnapshot();
  const scope = `${current.address?.toLowerCase()}:${current.connectorUid}:${current.version}`;
  const state: TxState = result.scope === scope ? result.state : { status: "idle" };
  let recovery: DelegatedAttempt | undefined;
  try { if (current.address && typeof window !== "undefined") recovery = attempts().read(current.address); } catch { /* run() fails closed on an unreadable saved request. */ }

  async function run(account: Address, calls: Call[], summarize?: (logs: readonly unknown[]) => { summary: string; tone: "bid" | "ask" | "neutral" }, delegated?: { previewBlock: bigint }, recoverSaved = false) {
    if (running.current) return;
    running.current = true;
    const setState = (state: TxState) => setResult({ scope, state });
    let last: Hash | undefined;
    let currentHash: Hash | undefined;
    let currentCall: Call | undefined;
    let phase: TxPhase | undefined;
    const completed: CompletedStep[] = [];
    let stop: (() => void) | undefined;
    let unlock: (() => void) | undefined;
    let terminalState: TxState | undefined;
    let attempt: DelegatedAttempt | undefined;
    let store: DelegatedAttemptStore | undefined;
    try {
      const guard = createWalletGuard(getSnapshot, account, chain.id);
      unlock = lockWalletTransaction(chain.id, account);
      if (delegated || calls.some(c => ["placeOrder", "cancel", "cancelAll"].includes(c.functionName))) {
        store = attempts();
        attempt = store.read(account);
      }
      if (attempt && calls.some(c => ["placeOrder", "cancel", "cancelAll"].includes(c.functionName))) {
        const c = calls[0];
        if (!delegated || calls.length !== 1)
          throw new Error("Recover the saved trading request before starting or changing an order.");
        assertAttemptBinding(attempt, { owner: account, chainId: chain.id, engine: c.address, action: c.functionName,
          calldata: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] }),
          connectorUid: guard.initial.connectorUid, sessionVersion: guard.initial.version }, recoverSaved);
      } else if (!delegated) attempt = undefined; // A saved order does not prevent custody actions.
      // Subscribe before any await so switching away and back during deployment
      // verification also permanently invalidates this sequence.
      stop = config.subscribe((s) => s, guard.observe);
      // Custody calls can target an archived vault; allocation also names the
      // engine in its arguments. Verify those deployments before any signature.
      const targets = new Set(calls.flatMap(c => [c.address,
        ...(c.functionName === "allocate" && typeof c.args?.[0] === "string" ? [c.args[0]] : [])]));
      await Promise.all([...targets].map(target => ensureDeployment(target)));
      guard.assertCurrent();
      const connector = getConnection(config).connector!;
      await runWalletCalls(calls, {
        assertCurrent: guard.assertCurrent,
        prepare: async (c) => {
          currentCall = c;
          currentHash = undefined;
          phase = "preflight";
          // The first attempt may already have filled. Its old preview must not
          // prevent retrieving the saved hash, and its body must remain exact.
          if (delegated && attempt) {
            // A recovered request may already be on-chain, even before this run sends anything.
            currentHash = attempt.hash;
            phase = attempt.hash ? "confirmation" : "signature";
            return { request: {}, gas: 0n };
          }
          setState({ status: "pending", step: `Simulating ${c.label}` });
          if ((c.account && c.account.toLowerCase() !== account.toLowerCase()) || (c.chainId && c.chainId !== chain.id)) throw new Error("Transaction belongs to a different wallet or network.");
          if (await client.getChainId() !== chain.id) throw new Error("RPC network changed. Remaining steps were stopped.");
          const block = await client.getBlock();
          if (Math.abs(Date.now() - Number(block.timestamp) * 1000) > 30000) throw new Error("RPC head is stale. Refresh before signing.");
          await c.validate?.(block.number);
          const sim = await client.simulateContract({ ...c, account, blockNumber: block.number } as never);
          guard.assertCurrent();
          const gas = await client.estimateContractGas({ ...c, account, blockNumber: block.number } as never);
          const gasLimit = (gas * 110n + 99n) / 100n;
          if (gasLimit > 30000000n) throw new Error("This action exceeds the transaction gas limit. Use a smaller batch.");
          if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("The preview block changed. Refresh and try again.");
          const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account }), client.getGasPrice()]);
          if (balance < gasLimit * gasPrice) throw new Error("Insufficient testnet MON for estimated gas. Open your wallet menu and choose Get test MON.");
          return { request: (sim as { request: object }).request, gas: gasLimit };
        },
        send: async ({ request, gas }, c) => {
          phase = delegated && attempt?.hash ? "confirmation" : "signature";
          setState({ status: "pending", step: `Confirm ${c.label} in your wallet` });
          // Explicitly bind the signer and chain instead of using whichever connector is now active.
          let hash: Hash;
          if (delegated) {
            if (calls.length !== 1 || !["placeOrder", "cancel", "cancelAll"].includes(c.functionName)) throw new Error("This action requires wallet confirmation.");
            setState({ status: "pending", step: attempt ? attempt.hash ? "Checking saved transaction" : "Recovering saved request" : "Signing with your Privy trading permission" });
            if (!attempt) {
              const body = validateIntent(JSON.parse(JSON.stringify({ wallet: account, engine: c.address, previewBlock: delegated.previewBlock.toString(), clientNonce: crypto.randomUUID(), action: c.functionName,
                ...(c.functionName === "placeOrder" ? { place: c.args?.[0] } : c.functionName === "cancel" ? { orderId: c.args?.[0] } : {}) }, (_, value) => typeof value === "bigint" ? value.toString() : value)), delegatedEngines);
              attempt = { version: 1, chainId: chain.id, body,
                calldata: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] }),
                connectorUid: guard.initial.connectorUid!, sessionVersion: guard.initial.version, createdAt: Date.now() };
            }
            hash = await recoverDelegatedAttempt(store!, attempt, body => privyRequest<{ hash: Hash }>("/api/trade", body, guard.assertCurrent));
          } else hash = await writeContract(config, { ...request, account, connector, chainId: chain.id, gas } as never);
          last = hash;
          currentHash = hash;
          return hash;
        },
        confirm: async (hash, c, final) => {
          phase = "confirmation";
          setState({ status: "sent", hash, step: `${c.label}: waiting for finality` });
          const readReceipt = () => finalizedOwnerReceipt(client, hash, { owner: account, to: c.address,
            data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] }) });
          const receipt = delegated && attempt ? await confirmDelegatedAttempt(store!, attempt, readReceipt) : await readReceipt();
          // Keep successful calls separate from any later simulation, signing or receipt failure.
          completed.push({ hash, label: c.label });
          currentHash = undefined;
          phase = "post-confirmation";
          const orders = parseEventLogs({ abi: engineAbi, eventName: "OrderPlaced", logs: receipt.logs.filter((l) => l.address.toLowerCase() === c.address.toLowerCase()) });
          rememberOrders(chain.id, c.address, account, orders.map((l) => l.args.id));
          guard.assertCurrent();
          if (final) {
            const out = summarize ? summarize(receipt.logs) : { summary: `${c.label} confirmed`, tone: "neutral" as const };
            terminalState = { status: "done", hash, ...out };
          }
        },
      });
    } catch (e) {
      terminalState = { status: "error", message: revertMessage(e, { functionName: currentCall?.functionName }),
        ...(currentHash ? { hash: currentHash } : {}), ...(currentCall ? { step: currentCall.label, phase } : {}),
        ...(completed.length ? { completed } : {}) };
    } finally {
      stop?.();
      // Finality ends the signing sequence. Release its lock before publishing
      // completion, so a confirmed transaction cannot block the next action.
      unlock?.();
      running.current = false;
      if (terminalState) setState(terminalState);
      // Refresh even after a partial sequence: an approval or deposit may already have succeeded.
      // Read failures are surfaced by the queries; they must not retain a signing lock.
      if (last) void qc.invalidateQueries().catch(() => {});
    }
  }

  async function recover(account: Address) {
    try {
      const saved = attempts().read(account);
      if (!saved) throw new Error("No saved trading request remains. Review the order before submitting.");
      await run(account, [{ ...delegatedCall(saved.body), label: "saved order" }], summarizeOrder,
        { previewBlock: BigInt(saved.body.previewBlock) }, true);
    } catch (error) { setResult({ scope, state: { status: "error", message: revertMessage(error) } }); }
  }
  return { state, run, recovery, recover, reset: () => setResult({ scope, state: { status: "idle" } }) };
}

/** placeOrder can succeed with id 0: fills, rejections and cancels come only from logs (R8). */
export function summarizeOrder(logs: readonly unknown[]): { summary: string; tone: "bid" | "ask" | "neutral" } {
  const ev = parseEventLogs({ abi: engineAbi, logs: logs as never });
  const rejected = ev.find((e) => e.eventName === "OrderRejected");
  if (rejected) return { summary: `Rejected: ${REJECT[Number((rejected.args as { reason: number }).reason)] || "order not admitted"}`, tone: "ask" };
  const fills = ev.filter((e) => e.eventName === "Fill") as { args: { size: bigint; tick: number } }[];
  const filled = fills.reduce((s, f) => s + f.args.size, 0n);
  const notional = fills.reduce((s, f) => s + f.args.size * BigInt(f.args.tick), 0n);
  const placed = ev.find((e) => e.eventName === "OrderPlaced") as { args: { id: number; size: bigint } } | undefined;
  const pruned = ev.filter((e) => e.eventName === "OrderCancelled") as { args: { reason: number } }[];
  const parts: string[] = [];
  if (filled > 0n) {
    const avgMilli = notional / filled; // avg tick, truncated
    parts.push(`Filled ${lotsToClaims(filled)} claims at avg 0.${avgMilli.toString().padStart(3, "0")}`);
  }
  if (placed) parts.push(`resting ${lotsToClaims(placed.args.size)} claims (order ${placed.args.id})`);
  if (pruned.length) parts.push(`${pruned.length} maker${pruned.length > 1 ? "s" : ""} removed (${CANCEL_REASON[pruned[0].args.reason] ?? "pruned"})`);
  if (parts.length === 0) parts.push("No fill and nothing rested (IOC remainder dropped or step limit reached)");
  return { summary: parts.join("; "), tone: filled > 0n || placed ? "bid" : "neutral" };
}
