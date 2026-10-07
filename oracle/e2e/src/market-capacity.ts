/** Demo admission headroom must coexist with the full depth used by the mark. */
export function testnetMarketCapacity(depthNLots: bigint) {
  if (depthNLots <= 0n || depthNLots > 1_000_000_000n) throw new Error('INVALID_DEMO_DEPTH')
  return { depthNLots, oiCapLots: depthNLots * 10n }
}
