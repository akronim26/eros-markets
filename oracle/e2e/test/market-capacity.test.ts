import { expect, test } from 'bun:test'
import { testnetMarketCapacity } from '../src/market-capacity'

test('demo OI cap retains a complete sampling depth after opening a position', () => {
  const capacity = testnetMarketCapacity(1_000_000n)
  // OI accounts for both sides of a 10-claim matched position.
  expect(capacity.oiCapLots - 2n * 10_000n).toBeGreaterThanOrEqual(capacity.depthNLots)
  expect(capacity.oiCapLots).toBe(10_000_000n)
  expect(() => testnetMarketCapacity(0n)).toThrow('INVALID_DEMO_DEPTH')
  expect(() => testnetMarketCapacity(-1n)).toThrow('INVALID_DEMO_DEPTH')
})
