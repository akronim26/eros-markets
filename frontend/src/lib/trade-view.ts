export type TradeOutcome = "YES" | "NO";
export type TradeDirection = "long" | "short";
export type TradeIntent = { outcome: TradeOutcome; direction: TradeDirection };
export type TradeSide = "buy" | "sell";

function validTick(tick: number) {
  if (!Number.isInteger(tick) || tick < 1 || tick > 999) throw new RangeError("Price must be a tick from 1 to 999");
}

/** NO is the complement of the one YES-denominated book, not a second instrument. */
export function canonicalTrade(intent: TradeIntent, displayTick: number) {
  validTick(displayTick);
  if (!["YES", "NO"].includes(intent.outcome) || !["long", "short"].includes(intent.direction)) throw new RangeError("Invalid trade intent");
  const isBuy = (intent.outcome === "YES") === (intent.direction === "long");
  return { isBuy, side: (isBuy ? "buy" : "sell") as TradeSide, tick: intent.outcome === "YES" ? displayTick : 1000 - displayTick };
}

export function displayTickForOutcome(outcome: TradeOutcome, canonicalTick: number) {
  validTick(canonicalTick);
  if (outcome !== "YES" && outcome !== "NO") throw new RangeError("Invalid outcome");
  return outcome === "YES" ? canonicalTick : 1000 - canonicalTick;
}

export type PositionEffect = {
  kind: "none" | "opens" | "increases" | "reduces" | "closes" | "reverses";
  beforeLots: bigint;
  afterLots: bigint;
  requestedLots: bigint;
  executedLots: bigint;
  closingLots: bigint;
  openingLots: bigint;
  clippedLots: bigint;
};

/** Conditional on this quantity filling. It does not predict execution or liquidity. */
export function positionEffect(beforeLots: bigint, isBuy: boolean, requestedLots: bigint, reduceOnly = false): PositionEffect {
  if (requestedLots < 0n) throw new RangeError("Negative order size");
  const absBefore = beforeLots < 0n ? -beforeLots : beforeLots;
  const opposite = beforeLots !== 0n && (beforeLots > 0n) !== isBuy;
  const executedLots = reduceOnly ? opposite ? requestedLots < absBefore ? requestedLots : absBefore : 0n : requestedLots;
  const closingLots = opposite ? executedLots < absBefore ? executedLots : absBefore : 0n;
  const openingLots = executedLots - closingLots;
  const afterLots = beforeLots + (isBuy ? executedLots : -executedLots);
  const kind = executedLots === 0n ? "none" : beforeLots === 0n ? "opens" : !opposite ? "increases"
    : afterLots === 0n ? "closes" : openingLots > 0n ? "reverses" : "reduces";
  return { kind, beforeLots, afterLots, requestedLots, executedLots, closingLots, openingLots, clippedLots: requestedLots - executedLots };
}

/** Structural limits only. Reserve, margin, order reservations and stage require previewOrder. */
export function orderSizeBounds(input: {
  positionLots: bigint; isBuy: boolean; reduceOnly: boolean;
  minOrderLots: bigint; maxOrderLots: bigint; maxAbsPositionLots?: bigint;
  reservedBidLots?: bigint; reservedAskLots?: bigint;
}) {
  const { positionLots, isBuy, reduceOnly, minOrderLots, maxOrderLots } = input;
  const positionLimit = input.maxAbsPositionLots ?? 1n << 40n;
  const reservedBidLots = input.reservedBidLots ?? 0n, reservedAskLots = input.reservedAskLots ?? 0n;
  if (minOrderLots <= 0n || maxOrderLots < minOrderLots || positionLimit <= 0n || positionLots < -positionLimit || positionLots > positionLimit
    || reservedBidLots < 0n || reservedAskLots < 0n) throw new RangeError("Invalid order bounds");
  let maxLots = isBuy ? positionLimit - positionLots - reservedBidLots : positionLimit + positionLots - reservedAskLots;
  if (maxLots < 0n) maxLots = 0n;
  if (reduceOnly) maxLots = positionEffect(positionLots, isBuy, maxLots, true).executedLots;
  if (maxLots > maxOrderLots) maxLots = maxOrderLots;
  return { minLots: minOrderLots, maxLots: maxLots < minOrderLots ? 0n : maxLots };
}
