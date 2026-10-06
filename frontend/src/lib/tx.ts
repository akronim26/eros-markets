"use client";

import { useRef, useState } from "react";
import { useConfig } from "wagmi";
import { getConnection, writeContract } from "wagmi/actions";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseEventLogs, type Abi, type Address, type Hash } from "viem";
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

export type TxState =
  | { status: "idle" }
  | { status: "pending"; step: string }
  | { status: "sent"; hash: Hash; step: string }
  | { status: "done"; hash: Hash; summary: string; tone: "bid" | "ask" | "neutral" }
  | { status: "error"; message: string };

/** Decode a revert into the contract's own error name (frontend.md §7.2). */
export function revertMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ? `Reverted: ${r.data.errorName}` : r.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; label: string; account?: Address; chainId?: number; validate?: () => Promise<void> };

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

  async function run(account: Address, calls: Call[], summarize?: (logs: readonly unknown[]) => { summary: string; tone: "bid" | "ask" | "neutral" }, delegated?: { previewBlock: bigint }) {
    if (running.current) return;
    running.current = true;
    const setState = (state: TxState) => setResult({ scope, state });
    let last: Hash | undefined;
    let stop: (() => void) | undefined;
    try {
      const guard = createWalletGuard(getSnapshot, account, chain.id);
      await ensureDeployment();
      guard.assertCurrent();
      const connector = getConnection(config).connector!;
      // Latch account/network changes, including switching away and back while a wallet prompt is open.
      stop = config.subscribe((s) => s, guard.observe);
      await runWalletCalls(calls, {
        assertCurrent: guard.assertCurrent,
        prepare: async (c) => {
          setState({ status: "pending", step: `Simulating ${c.label}` });
          if ((c.account && c.account.toLowerCase() !== account.toLowerCase()) || (c.chainId && c.chainId !== chain.id)) throw new Error("Transaction belongs to a different wallet or network.");
          if (await client.getChainId() !== chain.id) throw new Error("RPC network changed. Remaining steps were stopped.");
          await c.validate?.();
          const block = await client.getBlock();
          const sim = await client.simulateContract({ ...c, account, blockNumber: block.number } as never);
          guard.assertCurrent();
          const gas = await client.estimateContractGas({ ...c, account, blockNumber: block.number } as never);
          if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("The preview block changed. Refresh and try again.");
          const [balance, gasPrice] = await Promise.all([client.getBalance({ address: account }), client.getGasPrice()]);
          if (balance < gas * 110n / 100n * gasPrice) throw new Error("Insufficient testnet MON for estimated gas. Open your wallet menu and choose Get test MON.");
          return { request: (sim as { request: object }).request, gas };
        },
        send: async ({ request, gas }, c) => {
          setState({ status: "pending", step: `Confirm ${c.label} in your wallet` });
          // Explicitly bind the signer and chain instead of using whichever connector is now active.
          let hash: Hash;
          if (delegated) {
            if (calls.length !== 1 || !["placeOrder", "cancel", "cancelAll"].includes(c.functionName)) throw new Error("This action requires wallet confirmation.");
            setState({ status: "pending", step: "Signing with your Privy trading permission" });
            const response = await privyRequest<{ hash: Hash }>("/api/trade", { wallet: account, engine: c.address, previewBlock: delegated.previewBlock.toString(), clientNonce: crypto.randomUUID(), action: c.functionName,
              ...(c.functionName === "placeOrder" ? { place: c.args?.[0] } : c.functionName === "cancel" ? { orderId: c.args?.[0] } : {}) }, guard.assertCurrent);
            hash = response.hash;
          } else hash = await writeContract(config, { ...request, account, connector, chainId: chain.id, gas: (gas * 110n) / 100n } as never);
          last = hash;
          return hash;
        },
        confirm: async (hash, c, final) => {
          setState({ status: "sent", hash, step: `${c.label}: waiting for finality` });
          const receipt = await finalizedOwnerReceipt(client, hash, { owner: account, to: c.address,
            data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] }) });
          const orders = parseEventLogs({ abi: engineAbi, eventName: "OrderPlaced", logs: receipt.logs.filter((l) => l.address.toLowerCase() === c.address.toLowerCase()) });
          rememberOrders(chain.id, c.address, account, orders.map((l) => l.args.id));
          guard.assertCurrent();
          if (final) {
            const out = summarize ? summarize(receipt.logs) : { summary: `${c.label} confirmed`, tone: "neutral" as const };
            setState({ status: "done", hash, ...out });
          }
        },
      });
    } catch (e) {
      setState({ status: "error", message: revertMessage(e) + (last ? ` (last tx ${last.slice(0, 10)}…)` : "") });
    } finally {
      stop?.();
      running.current = false;
      // Refresh even after a partial sequence: an approval or deposit may already have succeeded.
      if (last) await qc.invalidateQueries();
    }
  }

  return { state, run, reset: () => setResult({ scope, state: { status: "idle" } }) };
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
