import type { Address, Hex } from 'viem'

type Integer = number | string | bigint

export type EnrollmentMarket = {
  engine: Address
  marketId: Hex
  sourceId: Hex
  listingHash: Hex
  sourceRulesHash: Hex
  erosRulesHash: Hex
  indexSigner: Address
  reserveVault: Address
  scheduledT: Integer
  depthNLots: Integer
  maxSpreadWad: Integer
  codehash?: Hex
  deploymentCapX?: Integer
  template?: Integer
  maxLiqLotsPerBlock?: Integer
  fundingEnabled?: boolean
}

export type EnrollmentBindings = {
  registry: Address
  resolutionAuthority: Address
  collateralVault: Address
  token: Address
  monitor: Address
  governance: Address
}

export function parseEnrollmentJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number' || Number.isSafeInteger(value)) return value
    if (!context?.source || !/^(0|[1-9][0-9]*)$/.test(context.source)) throw new Error('INEXACT_ENROLLMENT_NUMBER')
    return context.source
  })
}

function uint(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value)
  throw new Error('INEXACT_ENROLLMENT_NUMBER')
}

export function assertEnrollmentBindings(market: EnrollmentMarket, bindings: EnrollmentBindings, actual: {
  listing: unknown
  registryEngine: unknown
  collateralVault: unknown
  reserveVault: unknown
}) {
  const listing = actual.listing as Record<string, unknown>
  const equal = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase()
  const expectedStrings = {
    marketId: market.marketId, registry: bindings.registry, resolutionAuthority: bindings.resolutionAuthority,
    token: bindings.token, monitor: bindings.monitor, governance: bindings.governance, rulesHash: market.erosRulesHash,
    indexSourceId: market.sourceId, indexRulesHash: market.sourceRulesHash, indexSigner: market.indexSigner,
  }
  const expectedIntegers = { scheduledT: market.scheduledT, depthNLots: market.depthNLots, maxSpreadWad: market.maxSpreadWad }
  if (market.deploymentCapX !== undefined) {
    for (const key of ['deploymentCapX', 'template', 'maxLiqLotsPerBlock'] as const) {
      if (uint(listing[key]) !== uint(market[key])) throw new Error('MINED_RISK_CONFIGURATION_MISMATCH')
    }
    if (listing.fundingEnabled !== market.fundingEnabled || market.fundingEnabled !== false) throw new Error('MINED_RISK_CONFIGURATION_MISMATCH')
  }
  if (!listing || !Object.entries(expectedStrings).every(([key, value]) => equal(listing[key], value))
      || !Object.entries(expectedIntegers).every(([key, value]) => uint(listing[key]) === uint(value))
      || !equal(actual.registryEngine, market.engine) || !equal(actual.collateralVault, bindings.collateralVault)
      || !equal(actual.reserveVault, market.reserveVault)) throw new Error('MINED_LISTING_MISMATCH')
}
