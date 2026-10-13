/** Bounded chart geometry only; these numbers never set order amounts. */
export function depthBarWidth(lots: bigint, maxLots: bigint, availableWidth: number) {
  if (lots <= 0n || maxLots <= 0n || availableWidth <= 0) return 0;
  const width = Math.max(2, Number(lots * 1000n / maxLots) / 1000 * availableWidth);
  return Math.min(width, availableWidth);
}

export function bookTicks(bestBid: number, bestAsk: number, span = 30) {
  if (!bestBid && !bestAsk) return [];
  // Read outward from each touch. Sampling around the midpoint misses both
  // sides whenever the spread is wider than the sample window.
  const ticks = new Set<number>();
  for (let i = 0; i <= span; i++) {
    if (bestBid && bestBid - i >= 1) ticks.add(bestBid - i);
    if (bestAsk && bestAsk + i <= 999) ticks.add(bestAsk + i);
  }
  return [...ticks].sort((a, b) => a - b);
}
