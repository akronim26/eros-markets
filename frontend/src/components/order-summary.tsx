"use client";

import type { Address } from "viem";
import type { MarketSnapshot, TraderSnapshot } from "@/lib/reads";
import { useHistory } from "@/lib/history-reads";
import { usePositionBasis } from "@/lib/use-position-basis";
import { estimateTrade } from "@/lib/trade-estimate";
import { positionEffect, type TradeIntent } from "@/lib/trade-view";
import { positionLabel } from "@/lib/position-label";
import { atomsToUsdc, buyBackedAtoms, lotsToClaims, qToMoney, sellBackedAtoms } from "@/lib/units";
import { Row } from "./ui";

const money = (q: bigint) => `${qToMoney(q).usdc} USDC`;
const EFFECT = { none: "No position change", opens: "Opens position", increases: "Increases position",
  reduces: "Reduces position", closes: "Closes position", reverses: "Closes and reverses position" };

export function OrderSummary({ engine, owner, market, trader, tradeIntent, order, feeCapQ, admittedLots, unavailable }: {
  engine: Address; owner?: Address; market?: MarketSnapshot; trader?: TraderSnapshot; tradeIntent: TradeIntent;
  order?: { tick: number; lots: bigint; isBuy: boolean; reduceOnly: boolean };
  feeCapQ?: bigint; admittedLots?: bigint; unavailable: boolean;
}) {
  const history = useHistory(engine, owner, trader?.traderId, owner ? market?.block : undefined);
  const account = trader?.account?.preview;
  const current = !unavailable && !!market && trader?.block === market.block;
  const effect = order && account && current ? positionEffect(account.positionLots, order.isBuy, order.lots, order.reduceOnly) : undefined;
  const basis = usePositionBasis({ engine, owner, traderId: trader?.traderId ?? 0, history: history.data,
    block: market?.block, positionLots: account?.positionLots, enabled: current && !!effect?.closingLots });
  const estimate = order && current && admittedLots !== undefined && admittedLots >= order.lots
    ? estimateTrade({ trader, block: market!.block, ...order, feeCapQ, basis }) : undefined;
  const closing = !!effect?.closingLots;
  const openingOnly = !!effect && effect.openingLots > 0n && effect.closingLots === 0n;
  const backing = order && openingOnly ? (order.isBuy ? buyBackedAtoms(effect!.openingLots, order.tick) : sellBackedAtoms(effect!.openingLots, order.tick)) : undefined;
  const payoffOutcome = order?.isBuy ? "YES" : "NO";

  if (!order || !owner) return null;

  return <div className="hair-b -mx-3 border-t border-line px-3 py-2" aria-label="Order effect and estimate" aria-live="polite">
    <dl className="[&>div]:gap-3 [&>div]:py-1">
      <Row k="Effect if filled" v={effect ? EFFECT[effect.kind] : "Enter an order to preview"} />
      {effect && <Row k="Position after" v={positionLabel(effect.afterLots)} />}
      {!!effect?.clippedLots && <Row k="Reduce-only quantity" v={`${lotsToClaims(effect.executedLots)} claims`} hint="Reduce only cannot cross through zero into a new position." />}
      {openingOnly && <Row k="Full-backing amount" v={`${atomsToUsdc(backing!, 6)} USDC`} hint="Backing for the added exposure; fees are separate. This is not an exit value." />}
      <Row k="Fee cap reserved" v={feeCapQ !== undefined ? money(feeCapQ) : "—"} />
      {closing && estimate?.available && <>
        <Row k="Realized price P&L (est.)" v={estimate.positionPnl.available ? money(estimate.positionPnl.afterTradingFeesQ) : "Entry basis unavailable"} hint="Weighted-average entry basis, including allocated entry fees and the closing fee cap. Funding and premium affect the cash estimate separately." />
        <Row k="Market cash after fill (est.)" v={money(estimate.cashAfterQ)} />
      </>}
    </dl>
    {effect && <p className="mt-2 text-xs leading-relaxed text-fg-3">Assumes {lotsToClaims(effect.executedLots)} claims fill at your {tradeIntent.outcome} limit. Fills are not guaranteed.</p>}
    {closing && estimate?.available && <p className="mt-1 text-xs leading-relaxed text-fg-3">Cash stays in this market until released.</p>}
    {closing && !estimate?.available && <p className="mt-2 text-xs leading-relaxed text-fg-3">{estimate?.reason ?? "Waiting for an admitted order and current account preview to estimate exit value."}</p>}
    {effect && <details className="mt-2 text-xs text-fg-3">
      <summary className="cursor-pointer py-1 hover:text-fg">Estimate details</summary>
      <dl className="mt-1 [&>div]:gap-3 [&>div]:py-1">
        <Row k="Position before" v={positionLabel(effect.beforeLots)} />
        <Row k="Admitted from request" v={admittedLots !== undefined ? `${lotsToClaims(admittedLots)} claims` : "—"} />
        {openingOnly && <Row k={`Gross payoff if ${payoffOutcome}`} v={`${atomsToUsdc(effect.openingLots * 1000n, 6)} USDC`} hint="Gross settlement payoff on the added exposure, before its backing cost and charges." />}
        {closing && estimate?.available && <>
          <Row k="Pending funding included" v={money(estimate.projectedFundingQ)} hint="Already applied in account cash. Positive funding is charged; negative funding is a credit." />
          <Row k="Pending premium included" v={money(estimate.projectedPremiumQ)} />
          {estimate.potentialReleaseAtoms !== undefined ? <>
            <Row k="Potential release after close" v={`${atomsToUsdc(estimate.potentialReleaseAtoms, 6)} USDC`} />
            <Row k="Vault USDC after release (est.)" v={`${atomsToUsdc(estimate.vaultFreeAfterReleaseAtoms!, 6)} USDC`} />
          </> : <Row k="USDC available to release" v="Requires a fresh release preview" />}
        </>}
      </dl>
      <div className="grid gap-2 pb-1 pt-2 leading-relaxed">
        {openingOnly && <p>Backing excludes fees. Gross payoff is the settlement value before backing costs and charges.</p>}
        <p>Orders can fill partially or remain unfilled. All estimates assume the quantity shown fills at your limit price.</p>
        {closing && estimate?.available && <>
          <p>Price P&amp;L uses weighted-average entry prices, allocated entry fees and the closing fee cap. Funding and premium affect cash separately.</p>
          <p>Cash includes accrued funding and premium and subtracts the full fee cap. Positive funding is charged; negative funding is a credit. Actual fills, fees and later accrual can change the amount.</p>
          <p>Release to the vault and withdrawal to your wallet are separate actions.</p>
          {estimate.potentialReleaseAtoms !== undefined && <p>Release is an estimate, subject to a successful full close and the contract&apos;s release check.</p>}
          {!estimate.positionPnl.available && <p>{estimate.positionPnl.reason}. The cash estimate does not require an entry price.</p>}
        </>}
      </div>
    </details>}
  </div>;
}
