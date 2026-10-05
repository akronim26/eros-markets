"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useHead, useMarket } from "@/lib/reads";
import { markets, type MarketManifest } from "@/config/deployment";
import { fmtDuration, lotsToClaims, wadTo3 } from "@/lib/units";
import { chipFor } from "./market-parts";
import { Chip, Num, SectionRule } from "./ui";

function MarketRow({ mk, block, now }: { mk: MarketManifest; block?: bigint; now?: bigint }) {
  const m = useMarket(mk.engine, block);
  const d = m.data;
  const chip = d ? chipFor(d) : null;
  const toT = d && now !== undefined ? d.listing.scheduledT - now : undefined;
  return (
    <tr className="hair-b group hover:bg-hover">
      <td className="py-4 pr-6 pl-4">
        <Link href={`/m/${mk.engine}`} className="flex flex-col gap-1 after:absolute after:inset-0">
          <span className="text-sm font-semibold text-fg">{mk.title}</span>
          <span className="text-2xs text-fg-3">{mk.short} · {mk.resolution === "ORACLE" ? "Eros oracle" : "Manual test authority"}</span>
        </Link>
      </td>
      <td className="pr-6">{chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : <span className="text-fg-4">reading…</span>}</td>
      <td className="tnum pr-6 text-right text-sm">{d?.risk.markAvailable ? <span className="text-signal-text"><Num value={wadTo3(d.risk.markWad)} /></span> : <span className="text-fg-3">unavailable</span>}</td>
      <td className="tnum pr-6 text-right text-sm">{d?.risk.indexAvailable ? <Num value={wadTo3(d.risk.indexWad)} /> : <span className="text-fg-3">unavailable</span>}</td>
      <td className="tnum pr-6 text-right text-sm text-fg-2">{d ? lotsToClaims(d.oiLots) : "—"}</td>
      <td className="tnum pr-6 text-right text-sm text-fg-2">{d ? (d.listing.deploymentCapX === 1n ? "1x" : `${d.listing.deploymentCapX}x`) : "—"}</td>
      <td className="tnum pr-6 text-right text-sm text-fg">{toT !== undefined ? (toT > 0n ? <Num value={fmtDuration(toT)} /> : "passed") : "—"}</td>
      <td className="pr-4 text-right"><span className="inline-flex h-7 w-7 items-center justify-center bg-signal text-on-signal" aria-hidden><ArrowRight size={14} strokeWidth={2} /></span></td>
    </tr>
  );
}

/** Below md each market is a stacked framed block: no clipped table on a phone. */
function MarketCard({ mk, block, now }: { mk: MarketManifest; block?: bigint; now?: bigint }) {
  const d = useMarket(mk.engine, block).data;
  const chip = d ? chipFor(d) : null;
  const toT = d && now !== undefined ? d.listing.scheduledT - now : undefined;
  const rows: [string, React.ReactNode][] = [
    ["Mark", d?.risk.markAvailable ? <Num value={wadTo3(d.risk.markWad)} /> : "unavailable"],
    ["Index", d?.risk.indexAvailable ? <Num value={wadTo3(d.risk.indexWad)} /> : "unavailable"],
    ["Open interest", d ? lotsToClaims(d.oiLots) : "—"],
    ["Leverage", d ? (d.listing.deploymentCapX === 1n ? "1x" : `${d.listing.deploymentCapX}x`) : "—"],
    ["To halt", toT !== undefined ? (toT > 0n ? <Num value={fmtDuration(toT)} /> : "passed") : "—"],
  ];
  return (
    <li className="frame bg-ground">
      <div className="label flex items-center justify-between px-3 py-2 text-fg-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]">
        <span>{mk.short}</span>
        {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </div>
      <p className="px-3 pt-3 text-sm font-semibold leading-snug text-fg">{mk.title}</p>
      <dl className="px-3 py-2">
        {rows.map(([k, v]) => (
          <div key={k} className="hair-b flex justify-between py-1.5 text-xs">
            <dt className="text-fg-3">{k}</dt>
            <dd className="tnum text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <Link href={`/m/${mk.engine}`} className="group m-3 flex h-10 items-stretch">
        <span className="flex w-10 items-center justify-center bg-signal text-on-signal" aria-hidden>
          <ArrowRight size={15} strokeWidth={2} />
        </span>
        <span className="label flex flex-1 items-center bg-action px-4 text-on-action group-hover:bg-action-hover">Open market</span>
      </Link>
    </li>
  );
}

export function MarketsIndex() {
  const head = useHead();
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-10 pb-16 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <h1 className="pixel text-5xl leading-none text-fg uppercase">Markets</h1>
          <p className="mt-3 text-sm leading-relaxed text-fg-2">
            Each market is a YES/NO question that resolves at a scheduled time. Trade the probability as a perpetual on a fully
            on-chain order book. One claim pays 1 if the outcome is YES.
          </p>
        </div>
        {head.data && <p className="tnum text-xs text-fg-3">Read at block {head.data.number.toString()}</p>}
      </div>

      <div className="mt-10">
        <SectionRule name="LISTED" index={1} />
      </div>
      <ul className="mt-4 flex flex-col gap-3 md:hidden">
        {markets.map((mk) => (
          <MarketCard key={mk.engine} mk={mk} block={head.data?.number} now={head.data?.timestamp} />
        ))}
      </ul>
      <div className="mt-4 hidden overflow-x-auto md:block">
        <table className="relative w-full min-w-[860px] frame text-left">
          <thead>
            <tr className="hair-b text-2xs text-fg-3">
              <th className="py-2.5 pr-6 pl-4 font-medium">Market</th>
              <th className="pr-6 font-medium">Status</th>
              <th className="pr-6 text-right font-medium">Mark</th>
              <th className="pr-6 text-right font-medium">Index</th>
              <th className="pr-6 text-right font-medium">Open interest</th>
              <th className="pr-6 text-right font-medium">Leverage</th>
              <th className="pr-6 text-right font-medium">To halt</th>
              <th className="pr-4" aria-label="Open" />
            </tr>
          </thead>
          <tbody className="relative">
            {markets.map((mk) => (
              <MarketRow key={mk.engine} mk={mk} block={head.data?.number} now={head.data?.timestamp} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-fg-3">
        One market is deployed on Monad testnet today. Markets created through the oracle&apos;s market registry will list here once the
        registry-bound market factory is live.
      </p>
    </main>
  );
}
