"use client";

import { useState } from "react";
import { useConfig } from "wagmi";
import { writeContract } from "wagmi/actions";
import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Abi, type Address, type Hash } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "./reads";
import { engineAbi } from "@/abi/engine";
import { REJECT, CANCEL_REASON } from "./enums";
import { lotsToClaims } from "./units";

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

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; label: string };

/** preview → simulate → explicit gas (estimate × 1.10, Monad charges the limit) → send → receipt. */
export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  async function run(account: Address, calls: Call[], summarize?: (logs: readonly unknown[]) => { summary: string; tone: "bid" | "ask" | "neutral" }) {
    let last: Hash | undefined;
    try {
      for (const c of calls) {
        setState({ status: "pending", step: `Simulating ${c.label}` });
        const sim = await client.simulateContract({ ...c, account } as never);
        const gas = await client.estimateContractGas({ ...c, account } as never);
        setState({ status: "pending", step: `Confirm ${c.label} in your wallet` });
        const hash = await writeContract(config, { ...(sim as { request: object }).request, gas: (gas * 110n) / 100n } as never);
        last = hash;
        setState({ status: "sent", hash, step: `${c.label}: waiting for inclusion` });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`${c.label} reverted in block ${receipt.blockNumber}`);
        if (c === calls[calls.length - 1]) {
          const out = summarize ? summarize(receipt.logs) : { summary: `${c.label} confirmed`, tone: "neutral" as const };
          setState({ status: "done", hash, ...out });
        }
      }
      await qc.invalidateQueries();
    } catch (e) {
      setState({ status: "error", message: revertMessage(e) + (last ? ` (last tx ${last.slice(0, 10)}…)` : "") });
    }
  }

  return { state, run, reset: () => setState({ status: "idle" }) };
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
