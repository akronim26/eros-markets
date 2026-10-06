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
export function MarketHeader({ manifest, m }: { manifest: MarketManifest; m?: MarketSnapshot }) {
  const chip = m ? chipFor(m) : null;
  const spread = m && m.bestBid && m.bestAsk ? m.bestAsk - m.bestBid : null;
  return (
    <div className="hair-b flex min-h-14 flex-wrap items-center gap-x-8 gap-y-2 px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 md:flex-nowrap">
        <h1 className="text-base leading-snug font-semibold text-fg md:truncate">{manifest.title}</h1>
        {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </div>
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
        <Stat label="Mark" tone={m?.risk.markAvailable ? "signal" : undefined}>
          {m?.risk.markAvailable ? <Num value={wadTo3(m.risk.markWad)} /> : <Unavailable signal short="no mark" reason="No normal mark: bootstrap pricing or missing windows" />}
        </Stat>
        <Stat label="Index">
          {m?.risk.indexAvailable ? <Num value={wadTo3(m.risk.indexWad)} /> : <Unavailable short="no index" reason="No fresh signed index window" />}
        </Stat>
        <Stat label="Bid / Ask">
          {m && (m.bestBid || m.bestAsk) ? (
            <span className="tnum">
              <span className="text-bid">{m.bestBid ? (m.bestBid / 1000).toFixed(3) : "—"}</span>
              <span className="text-fg-4"> / </span>
              <span className="text-ask">{m.bestAsk ? (m.bestAsk / 1000).toFixed(3) : "—"}</span>
            </span>
          ) : (
            <Unavailable short={m ? "book empty" : "reading…"} reason={m ? "No resting orders on either side" : "Waiting for market data"} />
          )}
        </Stat>
        <Stat label="Spread">{spread !== null ? <Num value={(spread / 1000).toFixed(3)} /> : <span className="text-fg-3">—</span>}</Stat>
        <Stat label="Open interest">{m ? <Num value={`${lotsToClaims(m.oiLots)}`} /> : "—"}</Stat>
        <Stat label="Traders">{m ? <Num value={`${m.participants} / ${m.listing.maxTraders}`} /> : "—"}</Stat>
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
    <div className={cx(terminalStyles.deadlines, "hair-b grid min-h-[76px] grid-cols-1 items-center gap-4 px-4 py-3")}>
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
        <RegionHead title="Account" />
        <p className="p-3 text-sm leading-relaxed text-fg-3">
          Log in to see your balances, position and what you can withdraw. Your wallet is your trading account on this market.
        </p>
      </section>
    );
  }

  const settlement = m?.settlement;
  const claimable = settlement && isClaimable(settlement as never);
  const markOk = !!p && p.id.markAvailable;

  return (
    <section aria-label="Account" className="flex h-full flex-col">
      <RegionHead title="Account">{t && <span className="tnum">block {t.block.toString()}</span>}</RegionHead>
      <dl className="px-3 py-1">
        <Row k={`Wallet (${t?.assets.symbol ?? deployment.risk.collateralSymbol})`} v={t ? atomsToUsdc(t.wallet, 2) : "—"} />
        <Row k="Vault, free" v={t ? atomsToUsdc(t.free, 2) : "—"} />
        <Row k="Cash in market" v={p ? qToMoney(p.cashQ).usdc.replace(/(\.\d{2})\d+$/, "$1") : t ? "not funded" : "Reading…"} hint="Includes projected funding and premium; may be negative when leveraged" />
        <Row k="Position" v={p ? `${lotsToClaims(p.positionLots)} ${p.positionLots > 0n ? "YES" : p.positionLots < 0n ? "NO" : ""}` : "—"} />
        <Row k="Value if YES / NO" v={p ? `${qToMoney(p.e1Q).usdc.replace(/(\.\d{2})\d+$/, "$1")} / ${qToMoney(p.e0Q).usdc.replace(/(\.\d{2})\d+$/, "$1")}` : "—"} />
        <Row k="Equity at mark" v={p ? (markOk ? qToMoney(p.markEquityQ).usdc.replace(/(\.\d{2})\d+$/, "$1") : <Unavailable reason="No valid mark" />) : "—"} />
        <Row k="Health" v={p ? (markOk || p.positionLots === 0n ? HEALTH[p.status] : "unavailable") : "—"} />
        <Row k="Available to release" v={p ? atomsToUsdc(p.usableReleaseAtoms, 2) : "—"} hint="The only releasable amount: decided by the contract at this block" />
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
    <div className={cx(terminalStyles.details, "grid gap-x-8 px-4 py-2")}>
      <dl>
        <Row k="Stage" v={STAGE[m.risk.stage]} />
        <Row k="Pricing" v={PRICING[m.risk.pricingMode]} />
        <Row k="Accounting" v={ACCOUNTING[m.risk.accountingState]} />
        <Row k="Scheduled halt (T)" v={fmtUtc(l.scheduledT)} />
        <Row k="Listed" v={fmtUtc(l.listedAt)} />
      </dl>
      <dl>
        <Row k="Template" v={TEMPLATE[l.template]} />
        <Row k="Deployment ceiling" v={l.deploymentCapX === 1n ? "1x, fully backed" : `up to ${l.deploymentCapX}x`} />
        <Row k="Funding" v={m.fundingEnabled ? "on" : "off"} />
        <Row k="Order size" v={`${lotsToClaims(l.minOrderLots)} to ${lotsToClaims(l.maxOrderLots)} claims`} />
        <Row k="INVALID fallback" v={l.invalidRule.fallbackListed ? `${wadTo3(l.invalidRule.fallbackPriceWad)} after ${l.invalidRule.captureGraceSecs / 60n}m` : "none"} />
      </dl>
      <dl>
        <Row k="Worst-case capital lock" v={`${l.invalidRule.voidSecs / 86400n} days`} hint="Upper bound before an unresolved market voids to INVALID" />
        <Row k="Engine" v={<a className="inline-flex items-center gap-1 underline decoration-line-strong hover:text-fg" href={explorerAddress(manifest.engine)} target="_blank" rel="noreferrer">{shortAddr(manifest.engine)}<ExternalLink size={11} strokeWidth={1.75} aria-hidden /></a>} />
        <Row k="Resolution" v={manifest.resolution === "ORACLE" ? "Eros oracle" : "Manual test authority"} />
        <Row k="Risk profile" v={`v${m.profile.version} · ${m.profile.profileHash.slice(0, 10)}…`} />
        <Row k="Read at block" v={m.block.toString()} />
      </dl>
    </div>
  );
}


const usd2 = (q: bigint) => qToMoney(q).usdc.replace(/(\.\d{2})\d+$/, "$1");

/** Position and margin below the chart (contract FIRST VIEWPORT): contract previews only, at one block. */
export function PositionPanel({ m, t, onReduce }: { m?: MarketSnapshot; t?: TraderSnapshot; onReduce?: (bps: number) => void }) {
  const owner = useOwner();
  if (!owner.connected) return <p className="px-4 py-4 text-sm text-fg-3">Log in to see your position and margin.</p>;
  if (!t) return <p className="p-4 text-sm text-fg-3">Reading your account…</p>;
  const p = t.account?.preview;
  const r = t.account?.riskView;
  if (!p || !r) {
    return (
      <p className="max-w-xl px-4 py-4 text-sm leading-relaxed text-fg-3">
        No position on this market. Fund it from the account panel; your position, margin and open-order reservations appear here.
      </p>
    );
  }
  const markOk = p.id.markAvailable;
  const w = p.positionLots >= 0n ? p.id.markWad : 10n ** 18n - p.id.markWad;
  const exposureQ = (p.positionLots < 0n ? -p.positionLots : p.positionLots) * 1000n * w;
  const lev = markOk && p.markEquityQ > 0n && p.positionLots !== 0n ? (exposureQ * 100n) / p.markEquityQ : undefined;
  return (
    <div className={cx(terminalStyles.details, "grid gap-x-8 px-4 py-2")}>
      <dl>
        <Row k="Position" v={`${lotsToClaims(p.positionLots)} ${p.positionLots > 0n ? "YES" : p.positionLots < 0n ? "NO" : ""}`} />
        <Row k="Cash in market" v={usd2(p.cashQ)} hint="Already includes projected funding and premium; negative when leveraged" />
        <Row k="Value if YES" v={usd2(p.e1Q)} />
        <Row k="Value if NO" v={usd2(p.e0Q)} />
      </dl>
      <dl>
        <Row k="Equity at mark" v={markOk ? usd2(p.markEquityQ) : <Unavailable short="no mark" signal reason="No valid mark" />} />
        <Row k="Leverage" v={lev !== undefined ? `${lev / 100n}.${(lev % 100n).toString().padStart(2, "0")}x` : "—"} />
        <Row k="Initial / maintenance" v={p.fullBackingRequired ? "fully backed" : markOk ? `${usd2(BigInt(p.imQ))} / ${usd2(BigInt(p.mmQ))}` : "—"} />
        <Row k="Health" v={<span className={p.status >= 3 ? "text-signal-text" : undefined}>{markOk || p.positionLots === 0n ? HEALTH[p.status] : "unavailable"}{r.graceActive ? ` · grace until ${fmtUtc(r.graceEndsAt)}` : ""}</span>} />
      </dl>
      <dl>
        <Row k="Open bids" v={`${lotsToClaims(BigInt(p.orders.bidLots))} claims · ${usd2(p.orders.bidValueQ)}`} hint="Reserved by resting buy orders" />
        <Row k="Open asks" v={`${lotsToClaims(BigInt(p.orders.askLots))} claims · ${usd2(p.orders.askValueQ)}`} hint="Reserved by resting sell orders" />
        <Row k="Funding accrued" v={usd2(p.projectedFundingQ)} hint="Estimate; positive means you pay" />
        <Row k="Premium accrued" v={usd2(BigInt(p.projectedPremiumQ))} hint="Estimate" />
      </dl>
      {p.positionLots !== 0n && !m?.halted && <div className="col-span-full flex flex-wrap items-center gap-2 py-3"><Button onClick={() => onReduce?.(10000)}>Close position</Button>{(p.positionLots > 1n || p.positionLots < -1n) && <Button onClick={() => onReduce?.(5000)}>Reduce 50%</Button>}<span className="text-xs text-fg-3">Prepares a reduce-only IOC. Review its limit before signing.</span></div>}
      {m && <p className="col-span-full pb-1 text-2xs text-fg-3 tnum">Read at block {t!.block.toString()}</p>}
    </div>
  );
}
