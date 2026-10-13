/**
 * Kuru spot arithmetic for native YES/NO books. Units (verified on a Monad-testnet fork):
 * price = tick (pricePrecision 1000, 1 tick = 0.001), size = lot (sizePrecision 1000, 1 lot = 0.001 claim),
 * token atoms have 6 decimals, so one lot at tick p costs exactly p atoms of collateral.
 * Market buys take a quote size in units of 1000 atoms (0.001 tUSDC); market sells take a size in lots;
 * minAmountOut and the returned amount are token atoms. Integer arithmetic only.
 */
export type L2Level = { tick: number; lots: bigint };
export type L2 = { block: bigint; bids: L2Level[]; asks: L2Level[] };
export const LOT_ATOMS = 1000n;   // 1 lot = 0.001 claim = 1000 outcome-token atoms
export const QUOTE_UNIT_ATOMS = 1000n;

/** getL2Book() bytes: block word, (price, size) pairs for bids until a zero price, then asks likewise. */
export function decodeL2(data: `0x${string}`): L2 {
  if (!/^0x([0-9a-fA-F]{64})+$/.test(data)) throw new Error("Invalid Kuru book encoding.");
  const words = data.slice(2).match(/.{64}/g)!.map((w) => BigInt(`0x${w}`));
  let i = 1;
  const side = () => {
    const out: L2Level[] = [];
    while (i < words.length) {
      const price = words[i++];
      if (price === 0n) break;
      if (i >= words.length || price >= 1000n) throw new Error("Invalid Kuru book level.");
      const lots = words[i++];
      if (lots > 0n) out.push({ tick: Number(price), lots });
      if (out.length > 10000) throw new Error("Kuru book too large.");
    }
    return out;
  };
  const bids = side(), asks = side();
  if (words.slice(i).some((w) => w !== 0n)) throw new Error("Invalid Kuru book encoding.");
  return { block: words[0], bids: bids.sort((a, b) => b.tick - a.tick), asks: asks.sort((a, b) => a.tick - b.tick) };
}

export type Fill = { inAtoms: bigint; outAtoms: bigint; lots: bigint; worstTick?: number; complete: boolean };

/** Spend `quoteAtoms` (rounded down to whole quote units) against asks, best first. */
export function previewBuy(asks: L2Level[], quoteAtoms: bigint, takerFeeBps = 0n): Fill {
  let budget = (quoteAtoms / QUOTE_UNIT_ATOMS) * QUOTE_UNIT_ATOMS;
  const spend = budget;
  let lots = 0n, worstTick: number | undefined, bookLeft = false;
  for (const level of asks) {
    const take = budget / BigInt(level.tick) < level.lots ? budget / BigInt(level.tick) : level.lots;
    // Budget below this level's price, or the level only partly taken: liquidity remained.
    if (take < level.lots) bookLeft = true;
    if (take === 0n) break;
    lots += take; budget -= take * BigInt(level.tick); worstTick = level.tick;
    if (bookLeft) break;
  }
  const gross = lots * LOT_ATOMS;
  // Complete when the book still had liquidity at the point the budget ran out (leftover is dust below one lot).
  return { inAtoms: spend - budget, outAtoms: gross - (gross * takerFeeBps + 9999n) / 10000n, lots, worstTick, complete: bookLeft && lots > 0n };
}

/** Sell `lots` into bids, best first. */
export function previewSell(bids: L2Level[], lots: bigint, takerFeeBps = 0n): Fill {
  let left = lots, proceeds = 0n, worstTick: number | undefined;
  for (const level of bids) {
    if (left === 0n) break;
    const take = left < level.lots ? left : level.lots;
    proceeds += take * BigInt(level.tick); left -= take; worstTick = level.tick;
  }
  return { inAtoms: (lots - left) * LOT_ATOMS, outAtoms: proceeds - (proceeds * takerFeeBps + 9999n) / 10000n, lots: lots - left, worstTick, complete: left === 0n };
}

/** Minimum acceptable output for a slippage tolerance in basis points (rounded down). */
export const minOut = (expectedAtoms: bigint, slippageBps: number) => expectedAtoms * BigInt(10000 - slippageBps) / 10000n;

/** Collateral (atoms) a post-only bid locks, and outcome atoms a post-only ask locks. */
export const bidLockAtoms = (tick: number, lots: bigint) => BigInt(tick) * lots;
export const askLockAtoms = (lots: bigint) => lots * LOT_ATOMS;
