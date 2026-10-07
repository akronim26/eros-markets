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
