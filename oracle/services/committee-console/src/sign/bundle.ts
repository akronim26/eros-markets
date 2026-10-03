// A ReviewedProposal being signed: the proposal, its evidence URI and the members' signatures, kept as JSON until
// submitted.
import { oracleDomain, type ReviewedProposal, reviewedProposalDigest, reviewedProposalTypes } from '@eros-oracle/oracle-sdk'
import { type Address, getAddress, type Hex, keccak256, stringToBytes } from 'viem'
import { z } from 'zod'
import { type Case, type Choice, OUTCOME_CODE, type Sig } from '../backend/types'

export const MAX_EVIDENCE_URI_BYTES = 256 // OracleConst.MAX_EVIDENCE_URI_BYTES
/** Default time to collect signatures and submit. */
export const PROPOSAL_TTL_SECS = 6n * 3600n

export type Bundle = {
  version: 1
  chainId: number
  oracle: Address
  proposal: ReviewedProposal
  evidenceURI: string
  signatures: Sig[]
}

export class ProposalError extends Error {}

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => getAddress(s))
const bundleSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  oracle: address,
  proposal: z.object({
    marketId: hex32,
    outcome: z.number().int().min(1).max(3),
    evidenceHash: hex32,
    evidenceURIHash: hex32,
    noteHash: hex32,
    attempt: z.number().int().min(0).max(255),
    rejectedMask: z.number().int().min(0).max(255),
    early: z.boolean(),
    trustSetId: z.number().int().min(0).max(2 ** 32 - 1),
    deadline: z.string().regex(/^\d+$/).transform(BigInt),
  }).strict(),
  evidenceURI: z.string(),
  signatures: z.array(z.object({ signer: address, signature: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform((s) => s.toLowerCase() as Hex) }).strict()),
}).strict()

export function parseBundle(json: string): Bundle {
  const b = bundleSchema.parse(JSON.parse(json)) as Bundle
  if (keccak256(stringToBytes(b.evidenceURI)) !== b.proposal.evidenceURIHash) throw new ProposalError('evidenceURIHash does not match evidenceURI')
  return b
}

export const bundleJson = (b: Bundle) =>
  JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n'

export const bundleDigest = (b: Bundle): Hex => reviewedProposalDigest(oracleDomain(b.chainId, b.oracle), b.proposal)

/** The eth_signTypedData_v4 payload for a wallet. */
export function typedData(b: Bundle) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...reviewedProposalTypes,
    },
    primaryType: 'ReviewedProposal' as const,
    domain: oracleDomain(b.chainId, b.oracle),
    message: { ...b.proposal, deadline: b.proposal.deadline.toString() },
  }
}

/** Refuses a case the committee cannot act on now, a rejected outcome, or an evidence URI the contract would refuse. */
export function newBundle(c: Case, a: { chainId: number; oracle: Address; outcome: Choice; evidenceHash: Hex; evidenceURI: string; noteHash: Hex; now: bigint; ttlSecs?: bigint }): Bundle {
  if (!c.reviewable) throw new ProposalError(`market ${c.marketId} is ${c.state}: the committee cannot propose now`)
  if (!c.allowed.includes(a.outcome)) throw new ProposalError(`${a.outcome} is not allowed: the venue already rejected it`)
  const uriBytes = stringToBytes(a.evidenceURI).length
  if (uriBytes === 0 || uriBytes > MAX_EVIDENCE_URI_BYTES) throw new ProposalError(`evidence URI must be 1..${MAX_EVIDENCE_URI_BYTES} bytes`)
  let deadline = a.now + (a.ttlSecs ?? PROPOSAL_TTL_SECS)
  // An early proposal is accepted only before T and within the early TTL.
  if (c.early) {
    const end = [c.tau, c.deadlines.earlyExpiresAt ?? c.tau].reduce((x, y) => (x < y ? x : y)) - 1n
    if (end < deadline) deadline = end
  }
  return {
    version: 1,
    chainId: a.chainId,
    oracle: getAddress(a.oracle),
    proposal: {
      marketId: c.marketId.toLowerCase() as Hex,
      outcome: OUTCOME_CODE[a.outcome],
      evidenceHash: a.evidenceHash.toLowerCase() as Hex,
      evidenceURIHash: keccak256(stringToBytes(a.evidenceURI)),
      noteHash: a.noteHash.toLowerCase() as Hex,
      attempt: c.attempt,
      rejectedMask: c.rejectedMask,
      early: c.early,
      trustSetId: c.trustSetId,
      deadline,
    },
    evidenceURI: a.evidenceURI,
    signatures: [],
  }
}
