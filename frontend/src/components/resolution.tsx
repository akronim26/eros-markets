"use client";

import { useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { Hex } from "viem";
import { useOracleMarket } from "@/lib/reads";
import { oracleMarkets } from "@/config/deployment";
import { explorerAddress } from "@/config/chain";
import { ORACLE_OUTCOME, ORACLE_PATH, ORACLE_STATE } from "@/lib/enums";
import { fmtUtc, shortAddr } from "@/lib/units";
import { OracleActions } from "./oracle-actions";
import { useMarketList } from "@/lib/market-list";
import Link from "next/link";
import { Chip, Row, SectionRule } from "./ui";

const LIVE_STATES = new Set([5, 6, 7, 8]);

export function OracleMarket({ id, note = "", engine }: { id: Hex; note?: string; engine?: string }) {
  const q = useOracleMarket(id);
  if (q.isLoading) return <div className="hair-b px-4 py-6 text-sm text-fg-3">Reading the resolution oracle…</div>;
  if (q.isError || !q.data) return <div className="hair-b px-4 py-6 text-sm text-ask">Could not read this market from the oracle. Retrying.</div>;
  const { question, rules, core, resolution: r, evidenceURI, block } = q.data;
  const state = Number(r.state);
  const rejected = [1, 2, 3].filter((o) => (Number(r.rejectedMask) >> o) & 1).map((o) => ORACLE_OUTCOME[o]);
  return (
    <article className="hair-b grid grid-cols-1 gap-x-10 gap-y-6 px-4 py-6 lg:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={state === 10 ? "neutral" : LIVE_STATES.has(state) ? "warn" : "muted"}>{ORACLE_STATE[state]}</Chip>
          {state === 10 && <Chip tone="neutral">Final: {ORACLE_OUTCOME[Number(r.outcome)]}</Chip>}
        </div>
        <h2 className="mt-3 text-xl font-semibold leading-snug text-fg">{question}</h2>
        <details className="group mt-4">
          <summary className="label flex cursor-pointer list-none items-center gap-1.5 text-fg-2 hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight size={13} strokeWidth={2} className="transition-transform duration-150 group-open:rotate-90" aria-hidden />
            Resolution rules
          </summary>
          <p className="mt-2 max-w-[70ch] whitespace-pre-line text-sm leading-relaxed text-fg-2">{rules}</p>
        </details>
        {note && <p className="mt-4 text-xs leading-relaxed text-fg-3">{note}</p>}
        {engine && <Link href={`/m/${engine}`} className="mt-3 inline-block text-sm text-signal-text underline">Open trading terminal ↗</Link>}
      </div>
      <dl className="self-start">
        <Row k="Scheduled time (T)" v={fmtUtc(core.tau)} />
        <Row k="Halted at" v={r.haltedAt > 0n ? fmtUtc(r.haltedAt) : "not halted"} />
        <Row k="Proposed" v={Number(r.proposed) ? `${ORACLE_OUTCOME[Number(r.proposed)]} via ${ORACLE_PATH[Number(r.path)]}` : "none"} />
        <Row k="Attempts" v={`${r.attempts} of 3`} />
        <Row k="Rejected outcomes" v={rejected.length ? rejected.join(", ") : "none"} />
        <Row k="Void deadline" v={r.voidDeadline > 0n ? fmtUtc(r.voidDeadline) : `T + ${Number(core.voidSecs) / 86400} days`} hint="Every halted market reaches Final by this time at the latest" />
        <Row k="Evidence" v={evidenceURI ? <span className="break-all">{evidenceURI}</span> : "none yet"} />
        <Row k="Engine" v={<a className="inline-flex items-center gap-1 underline decoration-line-strong hover:text-fg" href={explorerAddress(core.engine)} target="_blank" rel="noreferrer">{shortAddr(core.engine)}<ExternalLink size={11} strokeWidth={1.75} aria-hidden /></a>} />
        <Row k="Read at block" v={block.toString()} />
      </dl>
      <OracleActions data={q.data} />
    </article>
  );
}


function ResolutionEntry({ id, title, engine }: { id: Hex; title?: string; engine?: string }) {
  const [open, setOpen] = useState(false);
  return <details className="hair-b" onToggle={(e) => setOpen(e.currentTarget.open)}><summary className="cursor-pointer break-all p-4 text-sm text-fg-2">{title ?? `Oracle market ${id.slice(0, 10)}…${id.slice(-6)}`}</summary>{open && <OracleMarket id={id} engine={engine} note={engine ? "" : "Oracle record; no verified trading book is connected."} />}</details>;
}

export function ResolutionPage() {
  const list = useMarketList();
  const ids = list.data?.oracleIds ?? oracleMarkets.map((m) => m.id);
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-10 pb-16 md:px-8">
      <h1 className="pixel text-5xl leading-none text-fg uppercase">Resolution</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-2">
        How each market&apos;s outcome is being decided: a data feed first, then a model panel and a human committee, with any
        proposal open to dispute before it becomes final. Payouts open only after the market&apos;s own settlement is prepared.
      </p>
      <p className="mt-6 max-w-3xl border-t border-b border-line py-3 text-xs leading-relaxed text-fg-2">
        Disputes on testnet are decided by the Eros team through a sandbox oracle, not by UMA voters. Layer 1 runs on a single
        simulation node, not a Chainlink DON.
      </p>
      <div className="mt-10">
        <SectionRule name="ORACLE_MARKETS" index={1} />
      </div>
      <div className="frame mt-4">
        {ids.map((id) => {
          const market = list.markets.find((m) => m.oracleMarketId === id);
          return <ResolutionEntry key={id} id={id} title={market?.title} engine={market?.engine} />;
        })}
      </div>
    </main>
  );
}
