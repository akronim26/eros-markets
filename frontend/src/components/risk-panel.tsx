"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MarketSnapshot, TraderSnapshot } from "@/lib/reads";
import { verifiedProfile } from "@/lib/capabilities";
import { healthAt, marginBoundaries } from "@/lib/margin-lens";
import { fmtDuration, qToMoney, tickToPrice } from "@/lib/units";
import { HEALTH } from "@/lib/enums";
import { Button, Chip, Row } from "./ui";

export function RiskPanel({ m, t }: { m: MarketSnapshot; t?: TraderSnapshot }) {
  const p = t?.account?.preview, r = t?.account?.riskView;
  const profile = verifiedProfile(m.profile.profileHash, m.listing.template, m.listing.deploymentCapX);
  const [tick, setTick] = useState(500);
  const [estimateBlock, setEstimateBlock] = useState<bigint>();
  const backed = p ? p.e0Q >= 0n && p.e1Q >= 0n : false;
  const lens = useQuery({ queryKey: ["lens", m.block.toString(), p?.cashQ.toString(), p?.positionLots.toString(), m.profile.profileHash, tick], enabled: !!p && !!profile && !backed && p.id.markAvailable,
    queryFn: () => healthAt(p!.cashQ, p!.positionLots, tick, m.risk.secsToT, m.risk.asOfTime, profile!, m.block) });
  const bounds = useQuery({ queryKey: ["margin-boundaries", estimateBlock?.toString(), p?.cashQ.toString(), p?.positionLots.toString(), m.profile.profileHash], enabled: estimateBlock === m.block && !!profile && !!p && !backed,
    queryFn: () => marginBoundaries(p!.cashQ, p!.positionLots, Number(p!.id.markWad / 10n ** 15n), m.risk.secsToT, m.risk.asOfTime, profile!, m.block), retry: false });
  const max = p ? [p.imQ, p.mmQ, p.markEquityQ, 1n].reduce((a, b) => a > b ? a : b) * 12n / 10n : 1n;
  const pct = (v: bigint) => Math.max(0, Math.min(100, Number(v * 10000n / max) / 100));
  return <section className="grid gap-5 p-4 sm:grid-cols-2" aria-label="Market risk">
    <div><h3 className="mb-2 text-base font-semibold">Position health</h3>
      {!p ? <p className="text-sm text-fg-3">Fund a market to see account margin and health.</p> : <>
        {backed ? <Chip>Fully backed · no price liquidation</Chip> : !p.id.markAvailable ? <p className="text-sm text-fg-3">Mark unavailable; margin estimates are paused.</p> : <>
          <p className="mb-2 text-sm text-signal-text">{HEALTH[p.status]}{r?.graceActive ? ` · grace remaining ${fmtDuration(r.graceEndsAt - m.risk.asOfTime)}` : ""}</p>
          <div className="relative mb-2 h-4 bg-press" role="img" aria-label={`Equity ${qToMoney(p.markEquityQ).usdc}, maintenance ${qToMoney(p.mmQ).usdc}, initial margin ${qToMoney(p.imQ).usdc}`}>
            <div className="h-full bg-bid" style={{ width: `${pct(p.markEquityQ)}%` }} />
            <span className="absolute top-0 h-full w-0.5 bg-ask" style={{ left: `${pct(p.mmQ)}%` }} /><span className="absolute top-0 h-full w-0.5 bg-fg" style={{ left: `${pct(p.imQ)}%` }} />
          </div><p className="text-xs text-fg-3">Orange: maintenance · Dark: initial margin</p>
        </>}
        {(p.status >= 2 || (m.risk.secsToT <= 45000n && !backed)) && <p role="alert" className="mt-3 border-l-2 border-signal pl-3 text-sm text-signal-text">Add collateral or reduce exposure. {p.status >= 3 ? "This account may be liquidatable now." : "Outstanding orders also reserve margin."} Full backing is required by T−12h.</p>}
        {!backed && profile && p.id.markAvailable && <div className="mt-4 grid gap-2">
          <label className="text-xs">What if the mark moves to {tickToPrice(tick)}?<input aria-label="Hypothetical mark" className="mt-2 w-full accent-signal" type="range" min="1" max="999" value={tick} onChange={(e) => setTick(Number(e.target.value))} /></label>
          <p className="text-xs text-fg-2">{lens.data ? `${HEALTH[lens.data.status]} · Equity ${qToMoney(lens.data.markEquityQ).usdc} · MM ${qToMoney(lens.data.mmQ).usdc}` : lens.isError ? "This RPC could not run the margin lens." : "Calculating…"}</p>
          <Button disabled={bounds.isFetching} onClick={() => setEstimateBlock(m.block)}>Estimate margin boundaries</Button>
          {bounds.data && <p className="text-xs text-fg-3">Nearest MM boundary: {bounds.data.mm ? tickToPrice(bounds.data.mm) : "none"}; IM: {bounds.data.im ? tickToPrice(bounds.data.im) : "none"}. At block {bounds.data.block.toString()}. Changes with time, funding and premium; mark is not the last trade.</p>}
          {bounds.isError && <p className="text-xs text-ask">Boundary calculation unavailable on this RPC.</p>}
        </div>}
        {!backed && m.listing.deploymentCapX > 1n && !profile && <p className="mt-2 text-xs text-fg-3">Liquidation estimates require the released profile matching this market&apos;s on-chain hash.</p>}
      </>}
    </div>
    <dl><Row k="Live leverage · long / short" v={`${m.leverageCaps.long}× / ${m.leverageCaps.short}×`} /><Row k="Deployment ceiling" v={`${m.listing.deploymentCapX}×`} hint="Admission depends on current prices, risk stage and reserve coverage." /><Row k="Reserve cash" v={qToMoney(m.reserve.cashQ).usdc} /><Row k="Conservative slack NO / YES" v={`${qToMoney(m.slacks.s0).usdc} / ${qToMoney(m.slacks.s1).usdc}`} hint="Coverage measure, not LP net asset value" /><Row k="Account deficit ceiling" v={qToMoney(m.reserveCapBaseQ * 2n / 100n).usdc} /><Row k="Funding" v={m.fundingEnabled ? m.epoch.stopped ? "Stopped" : "Enabled" : "Off"} />{m.fundingEnabled && <Row k="Signed epoch rate (wad)" v={m.epoch.rate.toString()} />}<Row k="Floor sweep" v={`${m.risk.floorCursor} / ${m.risk.floorCount}`} /><Row k="Liquidation budget (lots)" v={`${m.liqBudget.remaining} / ${m.liqBudget.cap}`} /><Row k="Read at block" v={m.block.toString()} /></dl>
  </section>;
}
