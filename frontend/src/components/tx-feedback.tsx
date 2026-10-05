"use client";
import Link from "next/link";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import type { TxState } from "@/lib/tx";
import { explorerTx } from "@/config/chain";

export function TxFeedback({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const failed = state.status === "error" || (state.status === "done" && state.tone === "ask");
  const busy = state.status === "pending" || state.status === "sent";
  return <div role={failed ? "alert" : "status"} className={`border p-3 text-xs leading-relaxed ${failed ? "border-ask/40 text-ask" : "border-line text-fg-2"}`}>
    <p className="flex items-start gap-2 break-words">{failed ? <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden /> : busy ? <LoaderCircle size={15} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden />}<span className="min-w-0 break-words">{state.status === "error" ? state.message : state.status === "done" ? state.summary : state.step}</span></p>
    {state.status === "sent" && <p className="mt-2 text-fg-3">Waiting for confirmation. Avoid submitting the same action again.</p>}
    {("hash" in state) && <div className="mt-2 flex flex-wrap gap-x-4"><a className="inline-flex min-h-9 items-center underline" href={explorerTx(state.hash)} target="_blank" rel="noreferrer">View transaction ↗</a>{state.status === "done" && !failed && <Link className="inline-flex min-h-9 items-center underline" href={`/thank-you?tx=${state.hash}`}>View confirmation →</Link>}</div>}
  </div>;
}
