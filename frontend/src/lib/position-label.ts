import { lotsToClaims } from "./units";

/** The engine holds one signed YES position; the displayed quantity is always positive. */
export function positionLabel(lots: bigint): string {
  const direction = lots > 0n ? "Long YES" : lots < 0n ? "Short YES" : "Flat";
  return `${direction} · ${lotsToClaims(lots < 0n ? -lots : lots)} claims`;
}

export function orderSideLabel(isBuy: boolean): "Buy YES" | "Sell YES" {
  return isBuy ? "Buy YES" : "Sell YES";
}
