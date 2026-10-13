import { getAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

export const traderAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value) as Address)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex)
const uint = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]*)$/)])
const deployed = z.object({ address: traderAddressSchema, codehash: hash, deployBlock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })

/** Public deployment identity only. Unknown fields (including transport credentials) are stripped. */
export const publicManifestObject = z.object({
  manifestVersion: z.literal(1).default(1),
  scope: z.enum(['local-only', 'testnet-read-only']),
  chainId: z.union([z.literal(31337), z.literal(10143)]),
  sourceCommit: z.string().min(1),
  riskScenario: z.enum(['fully-backed', 'leveraged-fixture', 'reserve-funded']).default('fully-backed'),
  sourceMode: z.enum(['fixture', 'polymarket']).default('fixture'),
  calibrationEvidence: z.string().optional(),
  provenance: z.object({
    collateral: z.enum(['fixture', 'testnet']),
    index: z.enum(['fixture', 'external']),
    calibration: z.enum(['none', 'synthetic', 'empirical']),
    resolution: z.enum(['fixture', 'oracle']),
  }).optional(),
  verifiedAt: z.object({ blockNumber: uint, blockHash: hash }).optional(),
  contracts: z.record(z.string(), deployed),
  markets: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), engine: traderAddressSchema, marketId: hash, sourceId: hash,
    listingHash: hash, codehash: hash, deployBlock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deploymentCapX: z.number().int().min(1).max(5).optional(), template: z.number().int().min(0).max(3).optional(),
    maxLiqLotsPerBlock: uint.optional(), fundingEnabled: z.boolean().optional(),
  })).min(1).max(64),
  accounts: z.record(z.string(), traderAddressSchema).default({}),
})

export function validatePublicManifest(value: z.infer<typeof publicManifestObject>, context: z.RefinementCtx) {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if ((value.scope === 'local-only') !== (value.chainId === 31337)) fail('MANIFEST_CHAIN_SCOPE_MISMATCH')
  for (const field of ['name', 'engine', 'marketId'] as const) {
    if (new Set(value.markets.map(market => market[field].toLowerCase())).size !== value.markets.length) fail('DUPLICATE_MARKET_IDENTITY')
  }
  for (const name of ['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken']) {
    if (!value.contracts[name]) fail(`Missing contract: ${name}`)
  }
  if (Object.keys(value.accounts).length > 32) fail('ACCOUNT_LIMIT_32')
  if (value.scope === 'testnet-read-only' && (!value.verifiedAt || !value.provenance || !value.contracts.MarketFactory)) {
    fail('TESTNET_REQUIRES_VERIFICATION_AND_PROVENANCE')
  }
}

export const publicManifestSchema = publicManifestObject.superRefine(validatePublicManifest)
export type PublicManifest = z.infer<typeof publicManifestSchema>

export function toPublicManifest(value: unknown): PublicManifest & { provenance: NonNullable<PublicManifest['provenance']> } {
  const manifest = publicManifestSchema.parse(value)
  return { ...manifest, provenance: manifest.provenance ?? {
    collateral: 'fixture', index: manifest.sourceMode === 'polymarket' ? 'external' : 'fixture', resolution: 'fixture',
    calibration: manifest.riskScenario === 'leveraged-fixture' ? 'synthetic' : 'none',
  } }
}
