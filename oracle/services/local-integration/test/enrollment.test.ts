import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { assertEnrollmentBindings, parseEnrollmentJson, type EnrollmentBindings, type EnrollmentMarket } from '../src/enrollment'

const address = (suffix: number) => `0x${suffix.toString(16).padStart(40, '0')}` as Address
const hash = (suffix: number) => `0x${suffix.toString(16).padStart(64, '0')}` as Hex
const market: EnrollmentMarket = {
  engine: address(1), marketId: hash(2), sourceId: hash(3), listingHash: hash(4), sourceRulesHash: hash(5),
  erosRulesHash: hash(6), indexSigner: address(7), reserveVault: address(8), scheduledT: 1800000000,
  depthNLots: 1000, maxSpreadWad: '50000000000000000',
}
const bindings: EnrollmentBindings = {
  registry: address(10), resolutionAuthority: address(11), collateralVault: address(12), token: address(13),
  monitor: address(14), governance: address(15),
}
const listing = {
  marketId: market.marketId, indexSourceId: market.sourceId, rulesHash: market.erosRulesHash,
  indexRulesHash: market.sourceRulesHash, indexSigner: market.indexSigner, registry: bindings.registry,
  resolutionAuthority: bindings.resolutionAuthority, token: bindings.token, monitor: bindings.monitor,
  governance: bindings.governance, scheduledT: 1800000000n, depthNLots: 1000n, maxSpreadWad: 50000000000000000n,
  listedAt: 1799900000n,
}
const actual = { listing, registryEngine: market.engine, collateralVault: bindings.collateralVault, reserveVault: market.reserveVault }

describe('local mined enrollment', () => {
  test('new risk metadata must match the mined listing; legacy manifests remain valid', () => {
    const metadata = { deploymentCapX: 5, template: 0, maxLiqLotsPerBlock: 100000, fundingEnabled: false }
    const actualRisk = { ...actual, listing: { ...listing, ...metadata } }
    expect(() => assertEnrollmentBindings({ ...market, ...metadata }, bindings, actualRisk)).not.toThrow()
    for (const mismatch of [{ deploymentCapX: 1 }, { template: 2 }, { maxLiqLotsPerBlock: 0 }, { fundingEnabled: true }]) {
      expect(() => assertEnrollmentBindings({ ...market, ...metadata, ...mismatch }, bindings, actualRisk)).toThrow('MINED_RISK_CONFIGURATION_MISMATCH')
    }
    expect(() => assertEnrollmentBindings(market, bindings, actual)).not.toThrow()
  })
  test('accepts exact bindings despite a different simulation listing timestamp/hash', () => {
    expect(() => assertEnrollmentBindings({ ...market, listingHash: hash(999) }, bindings,
      { ...actual, listing: { ...listing, listedAt: listing.listedAt + 1n } })).not.toThrow()
  })

  test('rejects every altered disclosed immutable string and integer', () => {
    for (const key of ['marketId', 'indexSourceId', 'rulesHash', 'indexRulesHash', 'indexSigner', 'registry', 'resolutionAuthority', 'token', 'monitor', 'governance']) {
      expect(() => assertEnrollmentBindings(market, bindings, { ...actual, listing: { ...listing, [key]: hash(999) } })).toThrow('MINED_LISTING_MISMATCH')
    }
    for (const key of ['scheduledT', 'depthNLots', 'maxSpreadWad'] as const) {
      expect(() => assertEnrollmentBindings(market, bindings, { ...actual, listing: { ...listing, [key]: listing[key] + 1n } })).toThrow('MINED_LISTING_MISMATCH')
    }
  })

  test('rejects engine, collateral-vault and reserve-vault substitution', () => {
    for (const key of ['registryEngine', 'collateralVault', 'reserveVault']) {
      expect(() => assertEnrollmentBindings(market, bindings, { ...actual, [key]: address(999) })).toThrow('MINED_LISTING_MISMATCH')
    }
  })

  test('preserves large JSON integer tokens instead of silently rounding WADs', () => {
    const parsed = parseEnrollmentJson('{"maxSpreadWad":50000000000000001,"scheduledT":1800000000}') as { maxSpreadWad: string; scheduledT: number }
    expect(parsed).toEqual({ maxSpreadWad: '50000000000000001', scheduledT: 1800000000 })
    expect(() => assertEnrollmentBindings({ ...market, maxSpreadWad: parsed.maxSpreadWad }, bindings, actual)).toThrow('MINED_LISTING_MISMATCH')
    expect(() => assertEnrollmentBindings({ ...market, maxSpreadWad: 50000000000000000 }, bindings, actual)).toThrow('INEXACT_ENROLLMENT_NUMBER')
    for (const text of ['{"depthNLots":1.5}', '{"maxSpreadWad":5e16}']) {
      expect(() => parseEnrollmentJson(text)).toThrow('INEXACT_ENROLLMENT_NUMBER')
    }
  })
})
