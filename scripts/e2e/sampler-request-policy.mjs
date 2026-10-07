/** A cadence skip leaves the same request outstanding until a sample can run. */
export function sampleCadenceRemaining(lastSampleBlock, block, sampleEveryBlocks) {
  if (lastSampleBlock === undefined) return 0n;
  const remaining = BigInt(lastSampleBlock) + sampleEveryBlocks - block;
  return remaining > 0n ? remaining : 0n;
}

/** A pending sample can be reconciled while the caller is asking for rollover. */
export function isFinalizedSample(result) {
  return result.action === 'sample' && result.outcome === 'finalized';
}
