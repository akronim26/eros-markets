/** `full`: the whole position (Close position), whose remaining collateral is returned to the wallet. */
export type CloseIntent = { nonce: number; side: "buy" | "sell"; size: string; price: string; full: boolean };
export function expiryBlock(input: string, current: bigint) {
  if (!input.trim()) return 0;
  if (!/^\d+$/.test(input)) throw new Error("Expiry must be a block number");
  const block = BigInt(input);
  if (block <= current || block > 0xffffffffn) throw new Error("Expiry must be a future block below 4,294,967,296");
  return Number(block);
}
/** Worst price a close may reach beyond the touch: 20 ticks (0.020). */
export const CLOSE_SLIPPAGE_TICKS = 20;
type DepthLevel = { tick: number; bidLots: bigint; askLots: bigint };

/**
 * Reduce-only close priced like a market sale: the limit is the level at which the book depth (`levels`)
 * covers the whole size, never more than `maxSlip` ticks beyond the touch. Without depth it uses the touch.
 */
export function closeIntent(lots: bigint, bid: number, ask: number, bps = 10000, levels: DepthLevel[] = [], maxSlip = CLOSE_SLIPPAGE_TICKS): CloseIntent {
  if (!lots || !Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error("No position to reduce");
  const size = (lots < 0n ? -lots : lots) * BigInt(bps) / 10000n;
  if (!size) throw new Error("Reduction is below one lot");
  const selling = lots > 0n, touch = selling ? bid : ask;
  let tick = touch;
  if (touch && levels.length) {
    const bound = selling ? Math.max(1, touch - maxSlip) : Math.min(999, touch + maxSlip);
    const side = levels.filter((l) => selling ? l.tick <= touch && l.tick >= bound && l.bidLots > 0n : l.tick >= touch && l.tick <= bound && l.askLots > 0n)
      .sort((a, b) => selling ? b.tick - a.tick : a.tick - b.tick);
    let filled = 0n; tick = bound;
    for (const l of side) { filled += selling ? l.bidLots : l.askLots; if (filled >= size) { tick = l.tick; break; } }
  }
  return { nonce: Date.now(), side: selling ? "sell" : "buy", size: `${size / 1000n}.${String(size % 1000n).padStart(3, "0")}`,
    price: tick ? `0.${String(tick).padStart(3, "0")}` : "", full: bps === 10000 };
}
