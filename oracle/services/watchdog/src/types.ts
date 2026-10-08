import type { FeedSpec } from '@eros-oracle/feedspec'
import type { Address, Hex } from 'viem'
import type { Liveness } from './timing'

/** Values are ABI (OracleTypes.sol): never reorder. */
export const Outcome = { NONE: 0, YES: 1, NO: 2, INVALID: 3 } as const
export const OUTCOME_NAME = ['NONE', 'YES', 'NO', 'INVALID'] as const
export type OutcomeName = 'YES' | 'NO' | 'INVALID'
export const Path = { NONE: 0, L1: 1, L2_AUTO: 2, REVIEWED: 3, PERMISSIONLESS: 4 } as const
export const PATH_NAME = ['NONE', 'L1', 'L2_AUTO', 'REVIEWED', 'PERMISSIONLESS'] as const
export const RState = { Proposed: 7, Disputed: 8, Final: 10 } as const

/** From ProposedL1 (Layer 1) or ProposalRecorded (every other path). */
export type Proposal = {
  marketId: Hex
  outcome: number
  path: number
  /** L1: keccak256 of the report; other paths: the snapshot hash. */
  evidenceHash: Hex
  /** Other paths only. */
  evidenceURI?: string
  /** L1 only: keccak256 of the value lexeme the workflow observed. */
  valueHash?: Hex
  /** L1 only. */
  observedAt?: bigint
  /** Resolution.attempts when recorded (or at intake, for ProposedL1). */
  attempt: number
  block: bigint
  logIndex: number
}

/** One proposal, one check: (market, attempt, path, evidence). */
export const proposalKey = (p: Proposal) => `${p.marketId.toLowerCase()}:${p.attempt}:${p.path}:${p.evidenceHash.toLowerCase()}`

export type ResolutionView = {
  state: number
  proposed: number
  path: number
  attempts: number
  assertionId: Hex
  assertionVenue: Address
  bond: bigint
  evidenceHash: Hex
}

export type AssertionStatus = { exists: boolean; settled: boolean; disputed: boolean; expiresAt: bigint; bond: bigint }

export type MarketText = { question: string; rules: string; tau: bigint; hasFeed: boolean }

export type WatchdogChain = {
  address: Address
  now(): Promise<bigint>
  /** Proposals and assertions since the last call, in log order. */
  events(): Promise<{ proposals: Proposal[]; asserted: { marketId: Hex; assertionId: Hex }[] }>
  resolution(id: Hex): Promise<ResolutionView>
  market(id: Hex): Promise<MarketText>
  liveness(id: Hex): Promise<Liveness>
  feedSpec(id: Hex): Promise<FeedSpec>
  allowList(id: Hex): Promise<string[]>
  assertion(venue: Address, assertionId: Hex): Promise<AssertionStatus>
  /** Zero address when revoked. */
  watchdogOf(id: Hex): Promise<Address>
  /** BondTreasury.balanceOf(WATCHDOG_FLOAT). */
  floatBalance(): Promise<bigint>
  openDisputes(): Promise<{ open: number; max: number }>
  lastHeartbeat(): Promise<bigint>
  simulateDispute(id: Hex): Promise<void>
  dispute(id: Hex, gas: bigint): Promise<Hex>
  heartbeat(gas: bigint): Promise<Hex>
}

export type Signal = {
  source: 'L1' | 'FALLBACK' | 'MODEL'
  /** Null when the source gives none (not final, an error, undetermined, low confidence). */
  outcome: OutcomeName | null
  detail: string
}

/**
 * AGREE: every answering source supports the proposal. CONTRADICT: every answering source supports another outcome.
 * UNSURE: none answered, or they disagree.
 */
export type Verdict = { kind: 'AGREE' | 'CONTRADICT' | 'UNSURE'; signals: Signal[]; reason: string }

export type Page = (event: { kind: string; marketId?: Hex; detail: string; data?: Record<string, unknown> }) => void | Promise<void>
