"use client";
import Link from "next/link";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import type { TxState } from "@/lib/tx";
import { explorerTx } from "@/config/chain";

export function TxFeedback({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  const failed = state.status === "error" || (state.status === "done" && state.tone === "ask");
  const busy = state.status === "pending" || state.status === "sent";
  const stoppedStep = state.status === "error" && state.step
    ? `${state.step[0].toUpperCase()}${state.step.slice(1)}${state.phase === "preflight" ? " was not submitted." : state.phase === "post-confirmation" ? " confirmed; remaining steps stopped." : " could not complete."}`
    : undefined;
  return <div role={failed ? "alert" : "status"} className={`border p-3 text-xs leading-relaxed ${failed ? "border-ask/40 text-ask" : "border-line text-fg-2"}`}>
    {stoppedStep && <p className="mb-2 font-medium">{stoppedStep}</p>}
    <p className="flex items-start gap-2 break-words">{failed ? <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden /> : busy ? <LoaderCircle size={15} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden />}<span className="min-w-0 break-words">{state.status === "error" ? state.message : state.status === "done" ? state.summary : state.step}</span></p>
    {state.status === "sent" && <p className="mt-2 text-fg-3">Waiting for confirmation. Avoid submitting the same action again.</p>}
    {state.status === "error" && !!state.completed?.length && <ul aria-label="Completed transaction steps" className="mt-2 border-t border-line pt-2 text-fg-2">
      {state.completed.map(step => <li key={step.hash}><a className="inline-flex min-h-9 items-center gap-1 underline" href={explorerTx(step.hash)} target="_blank" rel="noreferrer"><CheckCircle2 size={13} aria-hidden />Confirmed: {step.label} ↗</a></li>)}
    </ul>}
    {("hash" in state) && state.hash && <div className="mt-2 flex flex-wrap gap-x-4"><a className="inline-flex min-h-9 items-center underline" href={explorerTx(state.hash)} target="_blank" rel="noreferrer">{state.status === "error" && state.step ? `View ${state.step} transaction ↗` : "View transaction ↗"}</a>{state.status === "done" && !failed && <Link className="inline-flex min-h-9 items-center underline" href={`/thank-you?tx=${state.hash}`}>View confirmation →</Link>}</div>}
  </div>;
}
