"use client";
import type { TxState } from "@/lib/tx";
import { explorerTx } from "@/config/chain";

export function TxFeedback({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  return <p role={state.status === "error" ? "alert" : "status"} className={`break-words text-xs leading-relaxed ${state.status === "error" ? "text-ask" : "text-fg-2"}`}>
    {state.status === "error" ? state.message : state.status === "done" ? state.summary : state.step}
    {("hash" in state) && <> · <a className="underline" href={explorerTx(state.hash)} target="_blank" rel="noreferrer">View transaction</a></>}
  </p>;
}
