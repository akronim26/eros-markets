"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ArrowUpRight } from "lucide-react";
import type { Hash } from "viem";
import { client } from "@/lib/reads";
import { explorerTx } from "@/config/chain";
import { PendingState, ReadError } from "./feedback";

export function ThankYou({ hash }: { hash?: string }) {
  const valid = !!hash && /^0x[\da-fA-F]{64}$/.test(hash);
  const receipt = useQuery({ queryKey: ["confirmation-receipt", hash], enabled: valid, queryFn: () => client.getTransactionReceipt({ hash: hash as Hash }), retry: 1, staleTime: 30000 });
  const confirmed = receipt.data?.status === "success";
  return <main className="mx-auto flex min-h-[70vh] max-w-[1280px] items-center px-4 py-12 md:px-8 md:py-20">
    <div className="grid w-full gap-10 border-y border-line-strong py-10 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.65fr)] md:items-center md:gap-16">
      <div><p className="label text-signal-text">Eros Markets / Testnet</p><h1 className="pixel mt-5 text-[clamp(2.75rem,7vw,6rem)] leading-none uppercase">Thanks for<br />being early.</h1><p className="mt-6 max-w-lg text-sm leading-relaxed text-fg-2">You’re exploring a new way to trade event probabilities. Thanks for taking Eros Markets for a spin.</p>
        <div className="mt-8 flex flex-wrap gap-4"><Link href="/markets" className="label inline-flex min-h-12 items-center gap-4 bg-action px-5 text-on-action hover:bg-action-hover">Explore markets <ArrowRight size={16} aria-hidden /></Link><Link href="/portfolio" className="label inline-flex min-h-12 items-center gap-2 px-2 text-fg underline underline-offset-4">View portfolio <ArrowUpRight size={15} aria-hidden /></Link></div>
      </div>
      <section aria-label="Visit summary" className="border border-line-strong bg-panel p-5 sm:p-7">
        <div aria-hidden className="mb-8 grid h-16 w-16 place-items-center bg-signal text-on-signal">{confirmed ? <Check size={32} /> : <ArrowUpRight size={32} />}</div>
        {!hash ? <><h2 className="text-xl font-semibold">There’s more to explore.</h2><p className="mt-3 text-sm leading-relaxed text-fg-2">Browse an event market, inspect its order book, or revisit your positions. This page does not confirm a transaction.</p></> : !valid ? <ReadError message="That transaction reference is invalid. Open the confirmation link from your transaction result." retry={() => window.location.assign("/portfolio")} /> : receipt.isPending ? <PendingState>Checking the transaction on Monad testnet…</PendingState> : receipt.isError ? <ReadError message="We couldn’t verify this transaction yet. It may still be pending, or the connection may be unavailable." retry={() => { void receipt.refetch(); }} /> : <>
          <h2 className="text-xl font-semibold">{confirmed ? "Transaction confirmed." : "Transaction reverted."}</h2>
          <p role="status" className="mt-3 text-sm leading-relaxed text-fg-2">{confirmed ? "Recorded on Monad testnet. A confirmed transaction does not necessarily mean an order filled; review the result in your portfolio." : "The transaction was included, but its changes were reverted. Network fees may still apply."}</p>
          <p className="label mt-5 text-fg-3">Block {receipt.data?.blockNumber.toString()}</p>
        </>}
        {valid && <a className="mt-5 inline-flex min-h-11 items-center gap-2 text-xs text-fg underline" href={explorerTx(hash as Hash)} target="_blank" rel="noreferrer">View transaction <ArrowUpRight size={14} aria-hidden /></a>}
      </section>
    </div>
  </main>;
}
