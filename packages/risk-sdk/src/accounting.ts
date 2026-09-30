/** A-owned read-only accounting decoder. All monetary values are bigint Q. */
export const Q = 10n ** 18n;
export type AccountBalance = { positionLots: bigint; cashQ: bigint; fundingCheckpointQ: bigint };
export type MarketBalance = {
  allocationQ: bigint; reserveLots: bigint; reserveCashQ: bigint;
  protocolFeeQ: bigint; keeperPayableQ: bigint; fundingClearingQ: bigint;
  fundingCushionQ: bigint; fundingBudgetQ: bigint; oiAllLots: bigint;
};
export type AccountingEvent =
  | { name: "AccountBalance"; owner: string; value: AccountBalance }
  | { name: "MarketBalance"; value: MarketBalance };

export function unsignedAtoms(q: bigint): { atoms: bigint; residualQ: bigint } {
  if (q < 0n) throw new RangeError("negative Q cannot be paid");
  return { atoms: q / Q, residualQ: q % Q };
}
export function markedEquityQ(account: AccountBalance, priceWad: bigint): bigint {
  if (priceWad < 0n || priceWad > Q) throw new RangeError("priceWad");
  return account.cashQ + 1000n * account.positionLots * priceWad;
}
export class AccountingReplay {
  readonly accounts = new Map<string, AccountBalance>();
  market: MarketBalance | undefined;
  apply(event: AccountingEvent): void {
    if (event.name === "AccountBalance") this.accounts.set(event.owner.toLowerCase(), { ...event.value });
    else this.market = { ...event.value };
  }
  /** Check only after all logs of a successful transaction, before frozen payout allocation.
   * Raw posting/display Fill events are deliberately not applied a second time. */
  reconcileLive(): { cashDifferenceQ: bigint; netPositionLots: bigint } {
    if (!this.market) throw new Error("market snapshot unavailable");
    const m = this.market;
    let cash = m.reserveCashQ + m.protocolFeeQ + m.keeperPayableQ + m.fundingClearingQ;
    let lots = m.reserveLots;
    for (const a of this.accounts.values()) { cash += a.cashQ; lots += a.positionLots; }
    return { cashDifferenceQ: cash - m.allocationQ, netPositionLots: lots };
  }
}
