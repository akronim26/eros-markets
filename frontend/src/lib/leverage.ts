/** Q = 10^24 per token; one lot at one tick costs 10^18 Q. Fees remain in the preview. */
export function leverageLots(equityQ: bigint, tick: number, isBuy: boolean, leverage: number): bigint {
  if (equityQ <= 0n || !Number.isInteger(tick) || tick < 1 || tick > 999
    || !Number.isInteger(leverage) || leverage < 1 || leverage > 5) throw new Error("Invalid leverage sizing inputs.");
  return equityQ * BigInt(leverage) / (BigInt(isBuy ? tick : 1000 - tick) * 10n ** 18n);
}
