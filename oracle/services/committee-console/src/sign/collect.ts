// Collects committee signatures, each checked as the contract will: EOA signatures must recover the member (65 bytes,
// low s); contract members must pass ERC-1271. Only unrevoked members of the proposal's trust set count.
import { oracleDomain, recoverSigner, signReviewedProposal, sortCommitteeSigs } from '@eros-oracle/oracle-sdk'
import { type Address, getAddress, type Hex, isAddressEqual } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { type CaseChain, RState, type Sig } from '../backend/types'
import { type Bundle, bundleDigest, ProposalError } from './bundle'

export type SigCheck = { signer: Address; kind: 'EOA' | 'ERC1271'; ok: boolean; reason?: string }
export type Collected = { checks: SigCheck[]; valid: Sig[]; threshold: number; enough: boolean; erc1271: boolean }

/** Returns a new bundle with the member's signature added or replaced. */
export function withSignature(b: Bundle, sig: Sig): Bundle {
  const signer = getAddress(sig.signer)
  return { ...b, signatures: [...b.signatures.filter((s) => !isAddressEqual(s.signer, signer)), { signer, signature: sig.signature.toLowerCase() as Hex }] }
}

export async function signBundle(b: Bundle, account: LocalAccount): Promise<Bundle> {
  const signature = await signReviewedProposal(account, oracleDomain(b.chainId, b.oracle), b.proposal)
  if ((await recoverSigner(bundleDigest(b), signature)) !== getAddress(account.address)) throw new ProposalError('the local signature does not recover the signer')
  return withSignature(b, { signer: account.address, signature })
}

export async function collect(b: Bundle, chain: CaseChain): Promise<Collected> {
  const committee = await chain.committee(b.proposal.trustSetId)
  const digest = bundleDigest(b)
  const checks: SigCheck[] = []
  const valid: Sig[] = []
  let erc1271 = false
  for (const s of b.signatures) {
    const i = committee.members.findIndex((m) => isAddressEqual(m, s.signer))
    const contract = await chain.isContract(s.signer)
    const kind = contract ? 'ERC1271' : 'EOA'
    let reason: string | undefined
    if (i < 0) reason = `not a member of trust set ${b.proposal.trustSetId}`
    else if (committee.revoked[i]) reason = 'member revoked'
    else if (contract) {
      if (!(await chain.isValidSignature(s.signer, digest, s.signature))) reason = 'isValidSignature refused'
    } else if ((await recoverSigner(digest, s.signature)) !== getAddress(s.signer)) {
      reason = 'does not recover the signer (or high s, or v not 27/28)'
    }
    checks.push({ signer: getAddress(s.signer), kind, ok: reason === undefined, ...(reason ? { reason } : {}) })
    if (reason === undefined) {
      valid.push({ signer: getAddress(s.signer), signature: s.signature })
      erc1271 ||= contract
    }
  }
  const sorted = sortCommitteeSigs(valid)
  return { checks, valid: sorted, threshold: committee.threshold, enough: sorted.length >= committee.threshold, erc1271 }
}

/** Reasons the contract would refuse the bundle now; empty when it is current. */
export async function staleness(b: Bundle, chain: CaseChain): Promise<string[]> {
  const p = b.proposal
  const [r, now] = await Promise.all([chain.resolution(p.marketId), chain.now()])
  const out: string[] = []
  if (chain.chainId !== b.chainId || !isAddressEqual(chain.oracle, b.oracle)) out.push('signed for another chain or oracle')
  const early = r.state === RState.EarlyReview
  if (!early && r.state !== RState.Review && r.state !== RState.Open) out.push(`market is in state ${r.state}`)
  if (p.early !== early) out.push(early ? 'the market is in EarlyReview but the proposal is not early' : 'the proposal is early but the market is not in EarlyReview')
  if (p.attempt !== r.attempts) out.push(`attempt ${p.attempt}, the market is at ${r.attempts}`)
  if (p.rejectedMask !== r.rejectedMask) out.push(`rejectedMask ${p.rejectedMask}, the market has ${r.rejectedMask}`)
  if ((r.rejectedMask & (1 << p.outcome)) !== 0) out.push('the outcome was rejected by the venue')
  const setId = early ? await chain.activeTrustSetId() : r.trustSetId
  if (p.trustSetId !== setId) out.push(`trust set ${p.trustSetId}, the contract will use ${setId}`)
  if (now > p.deadline) out.push('the signatures expired (deadline passed)')
  return out
}
