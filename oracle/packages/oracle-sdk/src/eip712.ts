// Task O30.2: the EIP-712 messages the attestor and the committee sign (plan §6.4, D7, Appendix C.7), mirroring
// src/libraries/SigLib.sol. Type strings, domain and digests are checked against vectors/eip712.json, which
// Solidity writes; a change on either side fails test/eip712.test.ts.
import {
  type Address,
  type Hex,
  getAddress,
  hashStruct,
  hashTypedData,
  hexToBigInt,
  keccak256,
  recoverAddress,
  size,
  sliceHex,
  toBytes,
} from 'viem'
import type { LocalAccount } from 'viem/accounts'

export const DOMAIN_NAME = 'ErosResolutionOracle'
export const DOMAIN_VERSION = '1'

/** secp256k1 n / 2: SigLib refuses a signature with a larger `s` (the malleable twin). */
export const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

/** Enum values are ABI (OracleTypes.sol): never reorder. */
export const Outcome = { NONE: 0, YES: 1, NO: 2, INVALID: 3 } as const
export const PanelLabel = { ABSTAIN: 0, YES: 1, NO: 2, INVALID: 3, NOT_YET: 4 } as const
export const Phase = { NONE: 0, EARLY: 1, POST_T: 2 } as const
export const FLAG_INJECTION_SUSPECTED = 1

export const panelResultTypes = {
  PanelResult: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'phase', type: 'uint8' },
    { name: 'attempt', type: 'uint8' },
    { name: 'labels', type: 'uint8[3]' },
    { name: 'calibratedBps', type: 'uint16[3]' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'evidenceURIHash', type: 'bytes32' },
    { name: 'gateHash', type: 'bytes32' },
    { name: 'flags', type: 'uint8' },
    { name: 'trustSetId', type: 'uint32' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export const reviewedProposalTypes = {
  ReviewedProposal: [
    { name: 'marketId', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'evidenceURIHash', type: 'bytes32' },
    { name: 'noteHash', type: 'bytes32' },
    { name: 'attempt', type: 'uint8' },
    { name: 'rejectedMask', type: 'uint8' },
    { name: 'early', type: 'bool' },
    { name: 'trustSetId', type: 'uint32' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export type PanelResult = {
  marketId: Hex
  phase: number
  attempt: number
  labels: readonly [number, number, number]
  calibratedBps: readonly [number, number, number]
  evidenceHash: Hex
  evidenceURIHash: Hex
  gateHash: Hex
  flags: number
  trustSetId: number
  deadline: bigint
}

export type ReviewedProposal = {
  marketId: Hex
  outcome: number
  evidenceHash: Hex
  evidenceURIHash: Hex
  noteHash: Hex
  attempt: number
  rejectedMask: number
  early: boolean
  trustSetId: number
  deadline: bigint
}

export type OracleDomain = { name: string; version: string; chainId: number; verifyingContract: Address }

/** The oracle's domain on a chain: Solady EIP712 with name "ErosResolutionOracle", version "1". */
export function oracleDomain(chainId: number, verifyingContract: Address): OracleDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: getAddress(verifyingContract) }
}

/** keccak256 of a string's UTF-8 bytes, as the contract hashes marketId seeds, evidence URIs and notes. */
export const hashText = (s: string): Hex => keccak256(toBytes(s))

export function domainSeparator(domain: OracleDomain): Hex {
  return hashStruct({
    data: domain,
    primaryType: 'EIP712Domain',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  })
}

export const panelResultStructHash = (r: PanelResult): Hex =>
  hashStruct({ data: r, primaryType: 'PanelResult', types: panelResultTypes })

export const reviewedProposalStructHash = (p: ReviewedProposal): Hex =>
  hashStruct({ data: p, primaryType: 'ReviewedProposal', types: reviewedProposalTypes })

/** The digest `submitPanelResult` verifies (`hashPanelResult` on the contract). */
export const panelResultDigest = (domain: OracleDomain, r: PanelResult): Hex =>
  hashTypedData({ domain, types: panelResultTypes, primaryType: 'PanelResult', message: r })

/** The digest `submitReviewedProposal` verifies (`hashReviewedProposal` on the contract). */
export const reviewedProposalDigest = (domain: OracleDomain, p: ReviewedProposal): Hex =>
  hashTypedData({ domain, types: reviewedProposalTypes, primaryType: 'ReviewedProposal', message: p })

/** The attestor's 65-byte r‖s‖v signature over a panel result. */
export const signPanelResult = (account: LocalAccount, domain: OracleDomain, r: PanelResult): Promise<Hex> =>
  account.signTypedData({ domain, types: panelResultTypes, primaryType: 'PanelResult', message: r })

/** One committee member's signature over a reviewed proposal. */
export const signReviewedProposal = (account: LocalAccount, domain: OracleDomain, p: ReviewedProposal): Promise<Hex> =>
  account.signTypedData({ domain, types: reviewedProposalTypes, primaryType: 'ReviewedProposal', message: p })

/**
 * The signer of an EOA signature as SigLib accepts it: 65 bytes, v 27 or 28, low s. Returns null for any
 * signature the contract would refuse, so a service never submits one.
 */
export async function recoverSigner(digest: Hex, signature: Hex): Promise<Address | null> {
  if (size(signature) !== 65) return null
  const v = Number(hexToBigInt(sliceHex(signature, 64, 65)))
  if (v !== 27 && v !== 28) return null
  if (hexToBigInt(sliceHex(signature, 32, 64)) > HALF_N) return null
  return recoverAddress({ hash: digest, signature })
}

/**
 * Committee signatures in the order `submitReviewedProposal` requires: strictly ascending by signer. Throws on a
 * duplicate signer, which the contract would refuse as SignersNotSorted.
 */
export function sortCommitteeSigs<T extends { signer: Address }>(sigs: readonly T[]): T[] {
  const sorted = [...sigs].sort((a, b) => (hexToBigInt(a.signer) < hexToBigInt(b.signer) ? -1 : 1))
  for (let i = 1; i < sorted.length; i++) {
    if (hexToBigInt(sorted[i].signer) === hexToBigInt(sorted[i - 1].signer)) {
      throw new Error(`duplicate committee signer ${sorted[i].signer}`)
    }
  }
  return sorted
}
