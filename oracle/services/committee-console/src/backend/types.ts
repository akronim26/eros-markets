// Task O34.1: what the committee console reads from and sends to the chain (viem in chain.ts; an in-memory double in
// the tests), and the case it assembles for a reviewer (plan §8.4).
import type { ReviewedProposal } from '@eros-oracle/oracle-sdk'
import type { Address, Hex } from 'viem'

/** RState values (OracleTypes.sol; ABI, never reordered). */
export const RState = {
  None: 0, EarlyCheck: 1, EarlyReview: 2, L1Pending: 3, L2Pending: 4, Review: 5, Open: 6, Proposed: 7, Disputed: 8, Voided: 9, Final: 10,
} as const
export const STATE_NAME = Object.fromEntries(Object.entries(RState).map(([k, v]) => [v, k])) as Record<number, string>
export const OUTCOME_NAME = ['NONE', 'YES', 'NO', 'INVALID'] as const
export const LABEL_NAME = ['ABSTAIN', 'YES', 'NO', 'INVALID', 'NOT_YET'] as const
export type Choice = 'YES' | 'NO' | 'INVALID'
export const CHOICES: readonly Choice[] = ['YES', 'NO', 'INVALID']
export const OUTCOME_CODE: Record<Choice, number> = { YES: 1, NO: 2, INVALID: 3 }

export type ResolutionView = {
  state: number
  attempts: number
  rejectedMask: number
  haltedAt: bigint
  voidDeadline: bigint
  l2StartedAt: bigint
  retryOpensAt: bigint
  earlyStartedAt: bigint
  trustSetId: number
}

export type CoreView = { tau: bigint; hasFeed: boolean; gateHash: Hex; l2DeadlineSecs: bigint; earlyTtlSecs: bigint }

/** The latest `PanelResultAccepted` of a market, with its block time. */
export type PanelEvent = {
  phase: number
  labels: number[]
  calibratedBps: number[]
  evidenceHash: Hex
  evidenceURI: string
  routedTo: number
  at: bigint
}

export type Committee = { members: Address[]; threshold: number; revoked: boolean[] }

export type Sig = { signer: Address; signature: Hex }

export type CaseChain = {
  chainId: number
  oracle: Address
  now(): Promise<bigint>
  resolution(id: Hex): Promise<ResolutionView>
  core(id: Hex): Promise<CoreView>
  text(id: Hex): Promise<{ question: string; rules: string }>
  allowList(id: Hex): Promise<string[]>
  l1Url(id: Hex): Promise<string | undefined>
  activeTrustSetId(): Promise<number>
  committee(setId: number): Promise<Committee>
  lastPanelResult(id: Hex): Promise<PanelEvent | null>
  /** Block time of the market's latest StateChanged into `state`; null if it never entered it. */
  enteredAt(id: Hex, state: number): Promise<bigint | null>
  /** Markets with any StateChanged (the alerts' universe). */
  markets(): Promise<Hex[]>
  isContract(a: Address): Promise<boolean>
  /** ERC-1271: `isValidSignature(digest, signature) == 0x1626ba7e` on `signer`. */
  isValidSignature(signer: Address, digest: Hex, signature: Hex): Promise<boolean>
  /** eth_call of submitReviewedProposal; throws with the revert. */
  simulateReviewed(id: Hex, p: ReviewedProposal, uri: string, sigs: readonly Sig[]): Promise<void>
  sendReviewed(id: Hex, p: ReviewedProposal, uri: string, sigs: readonly Sig[], gas: bigint): Promise<Hex>
}

export type CaseItem = {
  index: number
  url: string
  host: string
  allowListed: boolean
  httpStatus: number
  contentType: string
  fetchedAt: number
  truncated: boolean
  error?: string
  /** The item's text as the panel saw it (HTML stripped); null for bytes that are not text. */
  text: string | null
}

export type CaseModel = {
  model: string
  label: string
  confidence: number | null
  cited: number[]
  rationale: string
  abstainReason?: string
}

export type Case = {
  marketId: Hex
  state: string
  /** The committee may propose now: Review, Open, or EarlyReview before T and within the early TTL. */
  reviewable: boolean
  early: boolean
  question: string
  rules: string
  tau: bigint
  attempt: number
  rejectedMask: number
  /** YES, NO, INVALID minus the outcomes the venue already rejected (ORC-6). */
  allowed: Choice[]
  /** The trust set a proposal is signed for: the active one from EarlyReview, the market's pinned one otherwise. */
  trustSetId: number
  committee: Committee
  evidence: {
    evidenceHash: Hex
    evidenceURI: string
    /** False when the snapshot is not in the local store (its items are then not shown). */
    available: boolean
    items: CaseItem[]
  } | null
  panel: {
    phase: number
    labels: string[]
    calibratedBps: number[]
    /** ĉ_i = calibratedBps / 10 000. */
    chat: number[]
    /** null when the runner's record is not in the store (the event does not carry the flags). */
    flags: number | null
    injectionSuspected: boolean | null
    routedTo: string
    at: bigint
    /** The runner's record (rationales, confidences, citations) when the store has it. */
    models: CaseModel[] | null
    candidate: { logOdds: number; probabilityYes: number; nEff: number }
  } | null
  deadlines: {
    /** When the market last entered Review (or EarlyReview). */
    reviewSince: bigint | null
    /** reviewSince + T_r: the review service level (§8.4). */
    serviceLevelAt: bigint | null
    l2DeadlineAt: bigint | null
    retryOpensAt: bigint | null
    earlyExpiresAt: bigint | null
    voidDeadline: bigint | null
  }
}
