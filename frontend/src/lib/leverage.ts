/** Size a flat, unreserved account using the engine's adverse-fill equity bound.
 * Q = 10^24 per token; a lot is 0.001 claims. Admission remains authoritative.
 */
export function leverageLots(equityQ: bigint, tick: number, isBuy: boolean, leverage: number,
  markWad = BigInt(tick) * 10n ** 15n, feePerLotQ = 0n): bigint {
  if (equityQ <= 0n || !Number.isInteger(tick) || tick < 1 || tick > 999
    || !Number.isInteger(leverage) || leverage < 1 || leverage > 5
    || markWad <= 0n || markWad >= 10n ** 18n || feePerLotQ < 0n) throw new Error("Invalid leverage sizing inputs.");
  const entryQ = BigInt(tick) * 10n ** 18n;
  const markQ = markWad * 1000n;
  const adverseQ = isBuy ? entryQ - markQ : markQ - entryQ;
  const lossPerLotQ = (adverseQ > 0n ? adverseQ : 0n) + feePerLotQ;
  const notionalPerLotQ = isBuy ? markQ : 10n ** 21n - markQ;
  // N / (cash - spread loss - fees) <= target. Round lots down; never
  // count a favourable limit fill as equity before it actually happens.
  return equityQ * BigInt(leverage) / (notionalPerLotQ + BigInt(leverage) * lossPerLotQ);
}

/**
 * Lots for one order so the whole position ends at `leverage`× after it fills, using the
 * Position panel's definition: |claims| × mark price of the held side ÷ mark equity.
 * Adding to the held side rounds down; trading against it (reducing) rounds up, so the result
 * never exceeds the target. A spread paid at the limit price lowers equity; a better-than-mark
 * fill is never counted. Returns 0n when the target is not reachable in this direction
 * (already at or above it when adding, at or below it when reducing). Never flips the position.
 * A flat account keeps `leverageLots` exactly. Admission remains authoritative.
 */
export function targetLeverageLots({ equityQ, positionLots, tick, isBuy, leverage, markWad, feePerLotQ = 0n }: {
  equityQ: bigint; positionLots: bigint; tick: number; isBuy: boolean; leverage: number; markWad?: bigint; feePerLotQ?: bigint;
}): bigint {
  if (positionLots === 0n) return leverageLots(equityQ, tick, isBuy, leverage, markWad, feePerLotQ);
  if (markWad === undefined) throw new Error("A live mark is required to size an open position.");
  if (equityQ <= 0n || !Number.isInteger(tick) || tick < 1 || tick > 999
    || !Number.isInteger(leverage) || leverage < 1 || leverage > 5
    || markWad <= 0n || markWad >= 10n ** 18n || feePerLotQ < 0n) throw new Error("Invalid leverage sizing inputs.");
  const entryQ = BigInt(tick) * 10n ** 18n, markQ = markWad * 1000n, target = BigInt(leverage);
  const adverseQ = isBuy ? entryQ - markQ : markQ - entryQ;
  const lossPerLotQ = (adverseQ > 0n ? adverseQ : 0n) + feePerLotQ;
  const long = positionLots > 0n, held = long ? positionLots : -positionLots;
  const sidePriceQ = long ? markQ : 10n ** 21n - markQ; // mark value of one held lot
  if (isBuy === long) {
    const room = target * equityQ - held * sidePriceQ;
    return room > 0n ? room / (sidePriceQ + target * lossPerLotQ) : 0n;
  }
  const excess = held * sidePriceQ - target * equityQ;
  const per = sidePriceQ - target * lossPerLotQ;
  if (excess <= 0n || per <= 0n) return 0n;
  const lots = (excess + per - 1n) / per;
  return lots < held ? lots : 0n;
}
