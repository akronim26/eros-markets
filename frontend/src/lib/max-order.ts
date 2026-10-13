export type CapacityPreview = { rejection: number; acceptedCapLots: bigint; feeCapQ: bigint };
export type MaxOrderResult<P extends CapacityPreview> = {
  block: bigint; lots: bigint; preview?: P; calls: number;
  searchComplete: boolean; upperBoundLots: bigint;
  label: "Largest verified size";
};

/** Search the listing bounds, not the currently entered size. Every call uses the same block.
 * The accepted cap from a rejected larger request can be a conservative halving result. Never
 * call that cap the global maximum: confirm candidate quantities with exact-size previews.
 * Search completeness concerns admission under the prefix-monotone contract predicate only;
 * it says nothing about book liquidity or admission at the transaction's later block.
 */
export async function findMaxOrder<P extends CapacityPreview>(input: {
  block: bigint; minLots: bigint; maxLots: bigint;
  preview: (lots: bigint, block: bigint) => Promise<P>;
  maxCalls?: number; signal?: AbortSignal;
}): Promise<MaxOrderResult<P>> {
  const { block, minLots, maxLots, preview, signal } = input;
  const maxCalls = input.maxCalls ?? 16;
  if (block < 0n || minLots <= 0n || maxLots < 0n || !Number.isInteger(maxCalls) || maxCalls < 2 || maxCalls > 64) throw new RangeError("Invalid capacity search bounds");
  let calls = 0, lots = 0n, best: P | undefined;
  let lower = minLots, upper = maxLots;
  const check = async (amount: bigint) => {
    signal?.throwIfAborted();
    const result = await preview(amount, block);
    signal?.throwIfAborted();
    calls++;
    if (result.acceptedCapLots < 0n || result.acceptedCapLots > amount || result.feeCapQ < 0n) throw new Error("Invalid contract capacity preview");
    const accepted = result.rejection === 0 && result.acceptedCapLots === amount;
    if (accepted) {
      lots = amount; best = result; lower = amount + 1n;
    } else upper = amount - 1n;
    return { accepted, result };
  };
  if (upper >= lower) {
    // Probe the full structural limit first; zero-entered or tiny-entered orders do not constrain Max.
    const high = await check(upper);
    if (!high.accepted && calls < maxCalls && upper >= lower) {
      // A halving result is useful as a candidate, but still verify that exact quantity.
      const hint = high.result.acceptedCapLots;
      await check(hint >= lower && hint <= upper ? hint : lower);
      // Probe upward near funded capacity before bisecting a potentially trillion-lot domain.
      // This also searches above the contract's conservative halving cap.
      while (lots > 0n && lower <= upper && calls < maxCalls) {
        const doubled = lots * 2n;
        const probe = doubled < upper ? doubled : upper;
        if (!(await check(probe)).accepted) break;
      }
    }
  }
  while (lower <= upper && calls < maxCalls) {
    await check((lower + upper + 1n) / 2n);
  }
  return { block, lots, preview: best, calls, searchComplete: lower > upper,
    upperBoundLots: upper > lots ? upper : lots, label: "Largest verified size" };
}
