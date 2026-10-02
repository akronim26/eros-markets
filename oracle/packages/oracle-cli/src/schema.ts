// The input of `oracle-cli list` (O22.2): what the lister decides, in the shape of the pack ListMarket reads
// (script/ListMarket.s.sol). The CLI adds marketId, dryRunHash and ambiguityLogHash. Integers that may exceed
// 2^53 are written as decimal strings (a JSON number above that has already lost precision when parsed).
import { z } from 'zod'

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`))
const bytes32 = hex(32)
const address = hex(20)
/** A uint as a safe JSON integer or a decimal string, as a bigint. */
const uint = z
  .union([
    z.number().int().nonnegative().refine(Number.isSafeInteger, 'above 2^53: write it as a decimal string'),
    z.string().regex(/^(0|[1-9][0-9]*)$/),
  ])
  .transform((v) => BigInt(v))
/** A unix time in seconds, or an ISO-8601 UTC time with a `Z` and no fractional seconds. */
const time = z
  .union([
    z.number().int().positive(),
    z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/).transform((s, ctx) => {
      const ms = Date.parse(s)
      if (Number.isNaN(ms)) ctx.addIssue({ code: 'custom', message: `bad time ${s}` })
      return ms / 1000
    }),
  ])
  .transform((v) => BigInt(v))
const small = (max: number) => z.number().int().min(0).max(max)

export const feedSchema = z.object({
  urlTemplate: z.string(),
  urlParam: z.string(),
  authRef: bytes32,
  finalPath: z.string(),
  finalValue: z.string(),
  valuePath: z.string(),
  valueType: small(255),
  decimals: small(255),
  op: small(255),
  target: z.string(),
  bufferSecs: small(0xffffffff),
  l1TimeoutSecs: small(0xffffffff),
})

export const listingSchema = z.object({
  /** marketId = keccak256 of the slug's UTF-8 bytes. */
  slug: z.string().min(1),
  /** The finished event of the same type whose response becomes reference.json (§12.9 step 2). */
  reference: z.object({ urlParam: z.string() }),
  marketInput: z.object({
    question: z.string().min(1),
    rules: z.string().min(1),
    claimTemplate: z.string(),
    windowStart: time,
    windowEnd: time,
    tau: time,
    groupId: bytes32,
    groupExclusive: z.boolean(),
    hasFeed: z.literal(true, { message: 'oracle-cli list builds Layer 1 packs: hasFeed must be true' }),
    feed: feedSchema,
    allowList: z.array(z.string()).min(1),
    ai: z.object({
      modelIdHashes: z.tuple([bytes32, bytes32, bytes32]),
      promptHash: bytes32,
      calibratorHash: bytes32,
      categoryId: bytes32,
      highConfBps: small(0xffff),
    }),
    uma: z.object({
      minBond: uint,
      bondBps: small(0xffff),
      livenessL1: uint,
      livenessAuto: uint,
      livenessReviewed: uint,
    }),
    l2DeadlineSecs: small(0xffffffff),
    voidSecs: small(0xffffffff),
    monitor: address,
    oiCapLots: uint,
  }),
  engineListing: z.object({
    engineGovernance: address,
    template: small(255),
    deploymentCapX: uint,
    maxTraders: small(0xffffffff),
    indexSourceId: bytes32,
    indexSigner: address,
    indexRulesHash: bytes32,
    depthNLots: uint,
    maxSpreadWad: uint,
    bootstrapBandWad: uint,
    minOrderLots: uint,
    maxOrderLots: uint,
    maxLiqLotsPerBlock: uint,
    fundingEnabled: z.boolean(),
  }),
  engineInit: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
})

export type Listing = z.infer<typeof listingSchema>

/** JSON with bigints written as plain numbers (stdJson reads uint256 numbers of any size). */
export function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `__uint:${x}__` : x), 2).replace(/"__uint:(\d+)__"/g, '$1') + '\n'
}
