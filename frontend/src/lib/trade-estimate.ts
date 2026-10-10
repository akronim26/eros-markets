import { positionEffect, type PositionEffect } from "./trade-view";

const Q = 10n ** 18n;
type Rational = { numerator: bigint; denominator: bigint };
const abs = (n: bigint) => n < 0n ? -n : n;
function fraction(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) throw new RangeError("Invalid fraction");
  let a = abs(numerator), b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
const add = (a: Rational, b: Rational) => fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const subtract = (a: Rational, b: Rational) => add(a, { ...b, numerator: -b.numerator });
const multiply = (a: Rational, n: bigint, d = 1n) => fraction(a.numerator * n, a.denominator * d);

class BasisComplexityLimit extends Error {}
/** Exact replay is optional UI work. Bound operands before multiplication/division,
 * and charge every arithmetic step against one budget, including Euclid's loop.
 * A row-count limit alone does not bound rational denominator growth.
 */
function basisArithmetic() {
  const maxBits = 2048, limit = 1n << BigInt(maxBits);
  let work = 1_000_000;
  const bits = (n: bigint) => {
    if (n <= -limit || n >= limit) throw new BasisComplexityLimit();
    return abs(n).toString(2).length;
  };
  const charge = (a: bigint, b: bigint) => {
    const aBits = bits(a), bBits = bits(b);
    work -= Math.ceil(aBits / 64) * Math.ceil(bBits / 64);
    if (work < 0) throw new BasisComplexityLimit();
    return [aBits, bBits];
  };
  const product = (a: bigint, b: bigint) => {
    const [aBits, bBits] = charge(a, b);
    if (a !== 0n && b !== 0n && aBits + bBits > maxBits) throw new BasisComplexityLimit();
    return a * b;
  };
  const sum = (a: bigint, b: bigint) => {
    const [aBits, bBits] = charge(a, b);
    if (Math.max(aBits, bBits) + 1 > maxBits) throw new BasisComplexityLimit();
    return a + b;
  };
  const ratio = (numerator: bigint, denominator = 1n): Rational => {
    if (denominator <= 0n) throw new RangeError("Invalid fraction");
    charge(numerator, denominator);
    let a = abs(numerator), b = denominator;
    while (b) { charge(a, b); [a, b] = [b, a % b]; }
    charge(numerator, a); charge(denominator, a);
    return { numerator: numerator / a, denominator: denominator / a };
  };
  return { product, sum, fraction: ratio,
    add: (a: Rational, b: Rational) => ratio(sum(product(a.numerator, b.denominator), product(b.numerator, a.denominator)), product(a.denominator, b.denominator)),
    multiply: (a: Rational, n: bigint, d = 1n) => ratio(product(a.numerator, n), product(a.denominator, d)),
  };
}
function floor(a: Rational) {
  const quotient = a.numerator / a.denominator;
  return quotient - (a.numerator < 0n && a.numerator % a.denominator !== 0n ? 1n : 0n);
}

export type PositionFill = { signedLots: bigint; tick: number; feeQ: bigint };
type Unavailable = { available: false; reason: string };
export type PositionBasis = Unavailable | {
  available: true; positionLots: bigint; entryValueQ: Rational; entryFeesQ: Rational;
  block: bigint; method: "weighted-average";
};

/** Reconstruct only the remaining position's entry basis from actual, direction-resolved fills.
 * Allocations, mark equity and a requested limit are not an entry price. Exact rational carrying
 * values avoid rounding the cost basis on every partial close. All mutations must be accounted
 * for; callers must mark unresolved pair reductions/takeovers/history as incomplete.
 */
export function reconstructPositionBasis(input: {
  fills: readonly PositionFill[]; complete: boolean; allPositionChangesKnown: boolean;
  throughBlock: bigint; snapshotBlock: bigint; expectedPositionLots: bigint;
}): PositionBasis {
  if (!input.complete || !input.allPositionChangesKnown) return { available: false, reason: "Complete, direction-resolved fill history is unavailable" };
  if (input.throughBlock !== input.snapshotBlock) return { available: false, reason: "Fill history and account snapshot are from different blocks" };
  if (input.fills.length > 20_000) return { available: false, reason: "Fill history exceeds the reconstruction limit" };
  const exact = basisArithmetic();
  let position = 0n, value = fraction(0n), fees = fraction(0n);
  try {
    for (const fill of input.fills) {
      if (fill.signedLots === 0n || !Number.isInteger(fill.tick) || fill.tick < 1 || fill.tick > 999 || fill.feeQ < 0n) return { available: false, reason: "Fill history contains invalid quantities, prices or fees" };
      const quantity = abs(fill.signedLots);
      const tradeValue = exact.fraction(exact.product(exact.product(quantity, BigInt(fill.tick)), Q));
      if (position === 0n || (position > 0n) === (fill.signedLots > 0n)) {
        value = exact.add(value, tradeValue);
        fees = exact.add(fees, exact.fraction(fill.feeQ));
      } else if (quantity < abs(position)) {
        const remaining = abs(position) - quantity;
        value = exact.multiply(value, remaining, abs(position));
        fees = exact.multiply(fees, remaining, abs(position));
      } else if (quantity === abs(position)) {
        value = fraction(0n); fees = fraction(0n);
      } else {
        const opening = quantity - abs(position);
        value = exact.multiply(tradeValue, opening, quantity);
        fees = exact.fraction(exact.product(fill.feeQ, opening), quantity);
      }
      position = exact.sum(position, fill.signedLots);
    }
  } catch (error) {
    if (!(error instanceof BasisComplexityLimit)) throw error;
    return { available: false, reason: "Entry basis exceeds the exact calculation complexity limit" };
  }
  if (position !== input.expectedPositionLots) return { available: false, reason: "Actual fills do not reconcile to the current position" };
  return { available: true, positionLots: position, entryValueQ: value, entryFeesQ: fees,
    block: input.snapshotBlock, method: "weighted-average" };
}

export type PositionVersionSnapshot = { block: bigint; positionLots: bigint; positionVersion: bigint };

/** Every production position posting increments positionVersion, including a round trip back
 * to the same quantity. This bridges indexer lag without equating unchanged quantity with an
 * unchanged entry basis. The history version also proves all position postings were represented
 * by the normalized fills; unresolved takeovers/pairs must remain unavailable.
 */
export function advancePositionBasis(basis: PositionBasis, historical: PositionVersionSnapshot,
  current: PositionVersionSnapshot, fillCount: number): PositionBasis {
  if (!basis.available) return basis;
  if (!Number.isSafeInteger(fillCount) || fillCount < 0 || historical.positionVersion !== BigInt(fillCount)) {
    return { available: false, reason: "Fill history does not cover every position change" };
  }
  if (basis.block !== historical.block || basis.positionLots !== historical.positionLots || current.block < historical.block) {
    return { available: false, reason: "Entry basis and historical account do not match" };
  }
  if (historical.positionVersion !== current.positionVersion || historical.positionLots !== current.positionLots) {
    return { available: false, reason: "Position changed after the loaded fill history; waiting for history to catch up" };
  }
  return { ...basis, block: current.block };
}

/** Structural subset of TraderSnapshot: preview.cashQ ALREADY includes projected accrual. */
export type EstimateTrader = {
  block: bigint; free: bigint;
  account: { preview: {
    cashQ: bigint; positionLots: bigint; projectedFundingQ: bigint; projectedPremiumQ: bigint;
    orders: { bidLots: bigint; askLots: bigint };
    id: { markAvailable: boolean; markWad: bigint };
  } } | null;
};
export type PositionPnlEstimate = Unavailable | {
  available: true; grossQ: bigint; afterTradingFeesQ: bigint;
  method: "weighted-average"; excludesFundingAndPremium: true;
};
export type TradeEstimate = Unavailable | {
  available: true; block: bigint; effect: PositionEffect;
  assumedTick: number; assumedFillLots: bigint;
  cashAfterQ: bigint; cashAfterAtoms: bigint; markEquityAfterQ?: bigint;
  potentialReleaseAtoms?: bigint; vaultFreeAfterReleaseAtoms?: bigint;
  projectedFundingQ: bigint; projectedPremiumQ: bigint; feeCapQ: bigint;
  positionPnl: PositionPnlEstimate; releaseGuaranteed: false;
};

/** Conditional fill-at-limit estimate, NOT a quote of executable depth or a release authorization.
 * The complete fee cap is charged conservatively. Accrual is reported, never debited a second
 * time. A partial close leaves exposed market cash; it must not be presented as withdrawable.
 */
export function estimateTrade(input: {
  trader: EstimateTrader | undefined; block: bigint; isBuy: boolean; lots: bigint;
  tick: number; reduceOnly: boolean; feeCapQ: bigint | undefined; basis?: PositionBasis;
}): TradeEstimate {
  const { trader, block, isBuy, lots, tick, reduceOnly, feeCapQ, basis } = input;
  if (!trader?.account) return { available: false, reason: "Account preview unavailable" };
  if (trader.block !== block) return { available: false, reason: "Account and order previews are from different blocks" };
  if (feeCapQ === undefined) return { available: false, reason: "An admitted order preview is required for the fee estimate" };
  if (lots <= 0n || !Number.isInteger(tick) || tick < 1 || tick > 999 || feeCapQ < 0n) return { available: false, reason: "Invalid fill assumption" };
  const account = trader.account.preview;
  const effect = positionEffect(account.positionLots, isBuy, lots, reduceOnly);
  if (!effect.executedLots) return { available: false, reason: "This order cannot reduce the current position" };
  const notionalQ = effect.executedLots * BigInt(tick) * Q;
  const cashAfterQ = account.cashQ + (isBuy ? -notionalQ : notionalQ) - feeCapQ;
  const cashAfterAtoms = floor(fraction(cashAfterQ, Q));
  const markEquityAfterQ = account.id.markAvailable
    ? cashAfterQ + effect.afterLots * 1000n * account.id.markWad : effect.afterLots === 0n ? cashAfterQ : undefined;
  const flatWithoutOrders = effect.afterLots === 0n && account.orders.bidLots === 0n && account.orders.askLots === 0n;
  const potentialReleaseAtoms = flatWithoutOrders ? (cashAfterAtoms > 0n ? cashAfterAtoms : 0n) : undefined;
  let positionPnl: PositionPnlEstimate = { available: false, reason: "Entry basis unavailable: complete actual fill history is required" };
  if (effect.closingLots === 0n) positionPnl = { available: false, reason: "This order does not close an existing position" };
  else if (basis && !basis.available) positionPnl = basis;
  else if (basis?.available && basis.block === block && basis.positionLots === account.positionLots) {
    const entry = multiply(basis.entryValueQ, effect.closingLots, abs(account.positionLots));
    const entryFees = multiply(basis.entryFeesQ, effect.closingLots, abs(account.positionLots));
    const exit = fraction(effect.closingLots * BigInt(tick) * Q);
    const gross = account.positionLots > 0n ? subtract(exit, entry) : subtract(entry, exit);
    const exitFees = fraction(feeCapQ * effect.closingLots, effect.executedLots);
    positionPnl = { available: true, grossQ: floor(gross), afterTradingFeesQ: floor(subtract(subtract(gross, entryFees), exitFees)),
      method: "weighted-average", excludesFundingAndPremium: true };
  }
  return { available: true, block, effect, assumedTick: tick, assumedFillLots: effect.executedLots,
    cashAfterQ, cashAfterAtoms, markEquityAfterQ, potentialReleaseAtoms,
    vaultFreeAfterReleaseAtoms: potentialReleaseAtoms === undefined ? undefined : trader.free + potentialReleaseAtoms,
    projectedFundingQ: account.projectedFundingQ, projectedPremiumQ: account.projectedPremiumQ,
    feeCapQ, positionPnl, releaseGuaranteed: false };
}
