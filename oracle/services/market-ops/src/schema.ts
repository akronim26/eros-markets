import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, stringToHex, type Hex } from 'viem'
import { z } from 'zod'

export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value))
export const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex)
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(BigInt)
const uint64 = decimal.refine(value => value < 2n ** 64n, 'uint64 overflow')
const uint256 = decimal.refine(value => value < 2n ** 256n, 'uint256 overflow')
const price = uint256.refine(value => value <= 10n ** 18n, 'price exceeds one claim')
const gas = z.number().int().positive().max(30_000_000)

export const manifestSchema = z.object({
  chainId: z.number().int().positive(),
  engine: address,
  engineCodeHash: bytes32,
  listingHash: bytes32,
  marketId: bytes32,
  oracle: address,
  oracleCodeHash: bytes32,
  sender: address,
  rolloverHelper: z.object({
    address,
    codeHash: bytes32,
    maxPages: z.number().int().min(1).max(32).default(32),
    gasCeiling: gas.default(30_000_000),
  }).strict().optional(),
  sampleEveryBlocks: decimal.refine(value => value > 0n).default(1n),
  gas: z.object({
    samplePerp: gas.optional(),
    requestReduceOnly: gas.optional(),
    requestEarlyCheck: gas.optional(),
    submitObservation: gas.optional(),
    liquidate: gas.optional(),
    beginRollover: gas.optional(),
    rollPage: gas.optional(),
    finishRollover: gas.optional(),
  }).strict(),
}).strict()

export type Manifest = z.infer<typeof manifestSchema>

export const observationSchema = z.object({
  marketId: bytes32,
  sourceId: bytes32,
  sequence: uint64,
  observedAt: uint64,
  publishedAt: uint64,
  priceWad: price,
  impactBidWad: price,
  impactAskWad: price,
  bidDepthLots: uint256,
  askDepthLots: uint256,
  sourceRulesHash: bytes32,
}).strict()

export type Observation = z.infer<typeof observationSchema>

export const envelopeSchema = z.object({
  chainId: z.number().int().positive(),
  engine: address,
  observation: observationSchema,
  signature: z.string().regex(/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/).transform(value => value as Hex),
}).strict()

export type Envelope = z.infer<typeof envelopeSchema>

export const incidentSchema = z.object({
  incident: z.string().min(1).max(200),
  reason: bytes32,
}).strict()

export type Incident = z.infer<typeof incidentSchema>

const observationType = keccak256(stringToHex('Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)'))
const observationTypes = parseAbiParameters('bytes32, bytes32, bytes32, uint64, uint64, uint64, uint256, uint256, uint256, uint256, uint256, bytes32, uint256, address')

export function observationDigest(envelope: Envelope): Hex {
  const observation = envelope.observation
  return keccak256(encodeAbiParameters(observationTypes, [
    observationType, observation.marketId, observation.sourceId, observation.sequence,
    observation.observedAt, observation.publishedAt, observation.priceWad, observation.impactBidWad,
    observation.impactAskWad, observation.bidDepthLots, observation.askDepthLots,
    observation.sourceRulesHash, BigInt(envelope.chainId), envelope.engine,
  ]))
}

export function incidentId(incident: Incident): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('string, bytes32'), [incident.incident, incident.reason]))
}

export function binding(manifest: Manifest): Hex {
  const legacy = keccak256(encodeAbiParameters(parseAbiParameters('uint256, address, address, address, bytes32, bytes32, bytes32, bytes32'), [
    BigInt(manifest.chainId), manifest.engine, manifest.oracle, manifest.sender, manifest.marketId,
    manifest.listingHash, manifest.engineCodeHash, manifest.oracleCodeHash,
  ]))
  if (!manifest.rolloverHelper) return legacy
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, address, bytes32'), [
    keccak256(stringToHex('eros-market-ops-rollover-helper-v1')), legacy,
    manifest.rolloverHelper.address, manifest.rolloverHelper.codeHash,
  ]))
}

export const equalHex = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
