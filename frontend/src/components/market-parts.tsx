"use client";

import type { Address } from "viem";
import { ExternalLink } from "lucide-react";
import { isClaimable, decodeSettlementStatus, STATUS_TEXT } from "@eros/risk-sdk";
import { type MarketSnapshot, type TraderSnapshot } from "@/lib/reads";
import { ACCOUNTING, HEALTH, PRICING, STAGE, TEMPLATE, marketChip } from "@/lib/enums";
import { atomsToUsdc, fmtDuration, fmtUtc, lotsToClaims, qToMoney, shortAddr, wadTo3 } from "@/lib/units";
import { deployment, type MarketManifest } from "@/config/deployment";
import { explorerAddress } from "@/config/chain";
import { useOwner } from "./wallet";
import { Button, Chip, Num, RegionHead, Row, Stat, Unavailable, cx } from "./ui";
import type { Point } from "@/lib/reads";
import { latestSourceObservation } from "@/lib/price-chart";
import { positionLabel } from "@/lib/position-label";
import terminalStyles from "./terminal.module.css";
import { AccountActions } from "./account-actions";

export function chipFor(m: MarketSnapshot) {
  return marketChip({
    active: m.active,
    halted: m.halted,
    stage: m.risk.stage,
    pricingMode: m.risk.pricingMode,
    accountingState: m.risk.accountingState,
    indexAvailable: m.risk.indexAvailable,
    markAvailable: m.risk.markAvailable,
    monitorRestricted: m.risk.monitorRestricted,
    claimsEnabled: m.settlement.claimsEnabled,
    phase: m.settlement.phase,
    recoveryRequired: m.settlement.recoveryRequired,
    oracleFinalityAccepted: m.settlement.oracleFinalityAccepted,
  });
}

/** Market header: identity, state, and the prices a trader reads first. */
export function MarketHeader({ manifest, m, source = [], now = Math.floor(Date.now() / 1000), readError = false }: { manifest: MarketManifest; m?: MarketSnapshot; source?: Point[]; now?: number; readError?: boolean }) {
  const observation = latestSourceObservation(source, now, readError);
  const chip = m ? chipFor(m) : null;
  const caps = m?.leverageCaps;
  return (
    <div className="hair-b flex min-h-14 flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
      <div className="flex min-w-0 flex-[1_1_18rem] flex-col items-start gap-1">
        <h1 className="w-full break-words text-sm leading-snug font-semibold text-fg">{manifest.title}</h1>
        {chip && <span className="max-w-full" title={chip.label}><Chip tone={chip.tone} className="h-auto min-h-6 max-w-full whitespace-normal py-1">{chip.label === "Paused: accounting sweep" ? "Trading paused" : chip.label}</Chip></span>}
      </div>
      <div className="flex min-w-0 flex-[2_1_28rem] flex-wrap items-center gap-x-6 gap-y-2">
        <Stat label="YES mark" tone={m?.risk.markAvailable ? "signal" : undefined}>
          {m?.risk.markAvailable ? <Num value={wadTo3(m.risk.markWad)} /> : <Unavailable signal short={m?.risk.pricingMode === 0 ? "warming" : "unavailable"} reason="The contract requires complete index, book and basis windows and normal pricing to provide a mark." />}
        </Stat>
        <Stat label="YES index">
          {m?.risk.indexAvailable ? <Num value={wadTo3(m.risk.indexWad)} /> : <Unavailable short={observation.fresh ? "warming" : "unavailable"} reason="The execution index requires a complete, fresh 300-second signed source window. A historical chart observation is not an executable index." />}
        </Stat>
        <Stat label="Open interest">{m ? <Num value={`${lotsToClaims(m.oiLots)}`} /> : "—"}</Stat>
        <Stat label={caps && caps.long !== caps.short ? "Leverage · YES long / short" : "Max leverage"}>
          {caps ? `${caps.long}×${caps.long !== caps.short ? ` / ${caps.short}×` : ""}` : "—"}
        </Stat>
        <Stat label={m?.halted ? "Scheduled close" : "Closes in"}>
          {m ? <span title={fmtUtc(m.listing.scheduledT)} className="tnum">{m.halted || m.listing.scheduledT <= BigInt(now) ? fmtUtc(m.listing.scheduledT) : fmtDuration(m.listing.scheduledT - BigInt(now))}</span> : "—"}
        </Stat>
      </div>
    </div>
  );
}

const DEADLINES = [
  { off: 45_000n, label: "Final-day grace", what: "New exposure must be fully backed" },
  { off: 43_200n, label: "Backing floor", what: "Accounts with a negative outcome value are taken over" },
  { off: 3_600n, label: "Reduce only", what: "No new exposure; reduce or top up" },
  { off: 0n, label: "Scheduled halt", what: "Trading stops; resolution begins" },
];

/** Shows only the next deadline at scale; the rest wait their turn (wayfinding raise). */
export function DeadlineStrip({ m, now }: { m?: MarketSnapshot; now?: bigint }) {
  if (!m || now === undefined) return <div className="hair-b h-[76px]" />;
  const T = m.listing.scheduledT;
  const next = DEADLINES.find((d) => T - d.off > now);
  const all = DEADLINES.map((d) => ({ ...d, at: T - d.off, passed: T - d.off <= now }));
  // Signal only when the final-day window is live risk; before that the next deadline is an Ivory mark.
  const finalDay = now >= T - 45_000n;
  return (
    <div className="hair-b grid min-h-[76px] grid-cols-1 items-center gap-4 px-4 py-3">
      <div>
        {next ? (
          <>
            <p className="label text-fg-3">Next: {next.label}</p>
            <p className="pixel text-4xl leading-tight text-fg">
              <Num value={fmtDuration(T - next.off - now)} />
            </p>
            <p className="text-2xs text-fg-3">{next.what}</p>
          </>
        ) : (
          <>
            <p className="text-2xs text-fg-3">Scheduled halt passed</p>
            <p className="text-2xl font-semibold text-fg">{fmtUtc(T)}</p>
          </>
        )}
      </div>
      <ol className={cx(terminalStyles.deadlineList, "grid gap-px bg-line")} aria-label="Market deadlines">
        {all.map((d) => (
          <li key={d.label} className={cx("flex flex-col gap-0.5 bg-ground px-3 py-2", next?.label === d.label && "bg-hover")}>
            <span className={cx("h-[3px] w-full", d.passed ? "bg-fg-4" : next?.label === d.label ? (finalDay ? "bg-signal" : "bg-fg") : "bg-line-strong")} aria-hidden />
            <span className={cx("mt-1.5 text-xs font-medium", d.passed ? "text-fg-4 line-through" : "text-fg-2")}>{d.label}</span>
            <span className="tnum text-2xs text-fg-3">{fmtUtc(d.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Account: what the wallet holds, what the market holds, what can leave. Contract numbers only (R2). */
export function AccountPanel({ engine, m, t, readUnavailable = false }: { engine: Address; m?: MarketSnapshot; t?: TraderSnapshot; readUnavailable?: boolean }) {
  const owner = useOwner();
  const p = t?.account?.preview;

  if (!owner.connected) {
    return (
      <section aria-label="Account" className="flex h-full flex-col">
        <RegionHead title="Balances" />
        <p className="p-3 text-xs leading-relaxed text-fg-3">
          Log in to view balances and manage collateral.
        </p>
      </section>
    );
  }

  const settlement = m?.settlement;
  const claimable = settlement && isClaimable(settlement as never);

  return (
    <section aria-label="Account" className="flex h-full flex-col">
      <RegionHead title="Balances"><span>{t?.assets.symbol ?? deployment.risk.collateralSymbol}</span></RegionHead>
      <dl className="px-3 py-1">
        <Row k="Wallet" v={t ? atomsToUsdc(t.wallet, 2) : "—"} />
        <Row k="Free vault" v={t ? atomsToUsdc(t.free, 2) : "—"} />
        <Row k="Market balance" v={p ? usd2(p.cashQ) : t ? "Not funded" : "Reading…"} hint="Market cash includes accrued funding and premium and can be negative when leveraged." />
        <Row k="Releasable" v={p ? atomsToUsdc(p.usableReleaseAtoms, 2) : "—"} hint="Collateral the contract currently permits you to move back to the vault." />
        {claimable && t?.account && <Row k="Claimable" v={atomsToUsdc(t.account.claimable, 2)} />}
      </dl>
      {settlement && settlement.halted && (
        <p className="px-3 pb-2 text-xs text-fg-2">{STATUS_TEXT[decodeSettlementStatus(settlement as never)]}</p>
      )}
      <AccountActions key={owner.address} engine={engine} m={m} t={t} readUnavailable={readUnavailable} />
    </section>
  );
}

/** Listing facts, addresses and capabilities: what this market is and what it allows. */
export function MarketInfo({ manifest, m }: { manifest: MarketManifest; m?: MarketSnapshot }) {
  if (!m) return <p role="status" className="p-4 text-sm text-fg-3">Waiting for market details…</p>;
  const l = m.listing;
  return (
    <div className="px-4 py-2">
      <div className={cx(terminalStyles.details, "grid gap-x-8")}>
        <dl>
          <Row k="Trading closes" v={fmtUtc(l.scheduledT)} />
          <Row k="Trading phase" v={STAGE[m.risk.stage]} />
          <Row k="Resolution" v={manifest.resolution === "ORACLE" ? "Eros oracle" : "Manual test authority"} />
          <Row k="Maximum resolution wait" v={`${l.invalidRule.voidSecs / 86400n} days`} hint="Upper bound before an unresolved market voids to INVALID; collateral can remain locked until settlement." />
        </dl>
        <dl>
          <Row k="Order size" v={`${lotsToClaims(l.minOrderLots)}–${lotsToClaims(l.maxOrderLots)} claims`} />
          <Row k="Leverage ceiling" v={l.deploymentCapX === 1n ? "1×, fully backed" : `${l.deploymentCapX}×`} hint="The available limit can be lower and is shown in the order ticket." />
          <Row k="Funding" v={m.fundingEnabled ? "Enabled" : "Disabled"} />
          <Row k="Trading fees" v="Shown in your order preview" />
        </dl>
      </div>
      <details className="mt-2 border-t border-line">
        <summary className="cursor-pointer py-3 text-xs text-fg-2 focus-visible:outline-2 focus-visible:outline-signal">Market rules & contract details</summary>
        <div className={cx(terminalStyles.details, "grid gap-x-8 pb-2")}>
          <dl>
            <Row k="Market type" v={TEMPLATE[l.template]} />
            <Row k="Pricing" v={PRICING[m.risk.pricingMode]} />
            <Row k="Accounting" v={ACCOUNTING[m.risk.accountingState]} />
            <Row k="Listed" v={fmtUtc(l.listedAt)} />
          </dl>
          <dl>
            <Row k="Missing-data fallback" v={l.invalidRule.fallbackListed ? `${wadTo3(l.invalidRule.fallbackPriceWad)} after ${l.invalidRule.captureGraceSecs / 60n}m` : "None listed"} />
            <Row k="Engine" v={<a className="inline-flex items-center gap-1 underline decoration-line-strong hover:text-fg" href={explorerAddress(manifest.engine)} target="_blank" rel="noreferrer">{shortAddr(manifest.engine)}<ExternalLink size={11} strokeWidth={1.75} aria-hidden /></a>} />
            <Row k="Risk profile" v={`v${m.profile.version} · ${m.profile.profileHash.slice(0, 10)}…`} />
            <Row k="Snapshot block" v={m.block.toString()} />
          </dl>
        </div>
      </details>
    </div>
  );
}


const usd2 = (q: bigint) => qToMoney(q).usdc.replace(/(\.\d{2})\d+$/, "$1");

/** Position and margin below the chart (contract FIRST VIEWPORT): contract previews only, at one block. */
export function PositionPanel({ m, t, onReduce }: { m?: MarketSnapshot; t?: TraderSnapshot; onReduce?: (bps: number) => void }) {
  const owner = useOwner();
  if (!owner.connected) return <p className="px-4 py-6 text-xs text-fg-3">Log in to see your positions.</p>;
  if (!t) return <p role="status" className="p-4 text-xs text-fg-3">Reading your account…</p>;
  const p = t.account?.preview;
  const r = t.account?.riskView;
  if (!p || !r) {
    return (
      <p className="px-4 py-6 text-xs leading-relaxed text-fg-3">
        No position yet. Open Manage collateral in Balances to fund this market.
      </p>
    );
  }
  const markOk = p.id.markAvailable;
  const w = p.positionLots >= 0n ? p.id.markWad : 10n ** 18n - p.id.markWad;
  const exposureQ = (p.positionLots < 0n ? -p.positionLots : p.positionLots) * 1000n * w;
  const lev = markOk && p.markEquityQ > 0n && p.positionLots !== 0n ? (exposureQ * 100n) / p.markEquityQ : undefined;
  const canReduce = !!m && !m.halted && t.block === m.block && !!onReduce;
  return (
    <div>
      {(r.graceActive || r.liquidationMode !== 0 || (markOk && p.status >= 3)) && <p role="status" className="border-b border-signal/30 bg-signal/5 px-4 py-2 text-xs text-signal-text">
        {r.graceActive ? `Margin grace ends ${fmtUtc(r.graceEndsAt)}. Add collateral or reduce your position.`
          : r.liquidationMode === 2 ? "Account eligible for takeover. Review your collateral immediately."
          : "Position at risk of liquidation. Add collateral or reduce your position."}
      </p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="hair-b text-fg-3"><tr>
            {["Position", "Equity (USDC)", "Leverage", "Health", "Actions"].map(label => <th key={label} scope="col" className="whitespace-nowrap px-4 py-2 font-normal">{label}</th>)}
          </tr></thead>
          <tbody><tr className="hair-b">
            <td className="whitespace-nowrap px-4 py-3 font-medium text-fg">{positionLabel(p.positionLots)}</td>
            <td className="px-4 py-3 tnum">{markOk ? usd2(p.markEquityQ) : <Unavailable short="No mark" signal reason="Equity is unavailable until a valid mark is available." />}</td>
            <td className="px-4 py-3 tnum">{lev !== undefined ? `${lev / 100n}.${(lev % 100n).toString().padStart(2, "0")}×` : "—"}</td>
            <td className={cx("whitespace-nowrap px-4 py-3", p.status >= 3 ? "text-signal-text" : "text-fg-2")}>{markOk || p.positionLots === 0n ? HEALTH[p.status] : "Unavailable"}</td>
            <td className="px-4 py-2">{p.positionLots !== 0n && !m?.halted ? <div className="flex items-center gap-2">
              <Button size="sm" disabled={!canReduce} onClick={() => onReduce?.(10000)} title="Prepare a reduce-only close order for review">Close position</Button>
              {(p.positionLots > 1n || p.positionLots < -1n) && <Button size="sm" disabled={!canReduce} onClick={() => onReduce?.(5000)} title="Prepare an order to reduce your position by half">Reduce 50%</Button>}
            </div> : <span className="text-fg-3">—</span>}</td>
          </tr></tbody>
        </table>
      </div>
      <details className="px-4">
        <summary className="cursor-pointer py-3 text-xs text-fg-2 focus-visible:outline-2 focus-visible:outline-signal">Margin & funding details</summary>
        <div className={cx(terminalStyles.details, "grid gap-x-8 pb-3")}>
          <dl>
            <Row k="Market balance" v={usd2(p.cashQ)} hint="Already includes projected funding and premium; negative when leveraged." />
            <Row k="Value if YES / NO" v={`${usd2(p.e1Q)} / ${usd2(p.e0Q)}`} />
            <Row k="Initial / maintenance margin" v={p.fullBackingRequired ? "Fully backed" : markOk ? `${usd2(BigInt(p.imQ))} / ${usd2(BigInt(p.mmQ))}` : "—"} />
          </dl>
          <dl>
            <Row k="Open YES bids" v={`${lotsToClaims(BigInt(p.orders.bidLots))} claims · ${usd2(p.orders.bidValueQ)}`} />
            <Row k="Open YES asks" v={`${lotsToClaims(BigInt(p.orders.askLots))} claims · ${usd2(p.orders.askValueQ)}`} />
            <Row k="Funding accrued" v={usd2(p.projectedFundingQ)} hint="Included in market balance. Positive means you pay." />
            <Row k="Premium accrued" v={usd2(BigInt(p.projectedPremiumQ))} hint="Included in market balance." />
          </dl>
        </div>
        <p className="pb-3 text-2xs text-fg-3">Close and reduce prepare a reduce-only IOC order. Review its price before signing.</p>
      </details>
    </div>
  );
}
