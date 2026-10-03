// Task O37.2: helpers shared by the handlers. Enum numbers are OracleTypes.sol's (ABI: never reorder).
import type { Assertion, Market } from 'envio'

export const STATE = ['None', 'EarlyCheck', 'EarlyReview', 'L1Pending', 'L2Pending', 'Review', 'Open', 'Proposed', 'Disputed', 'Voided', 'Final'] as const
export const PATH = ['NONE', 'L1', 'L2_AUTO', 'REVIEWED', 'PERMISSIONLESS'] as const
export const RS = { Review: 5, Open: 6, Proposed: 7, Disputed: 8, Final: 10 } as const
/** The states Disputes Live lists (plan §9.5). */
export const LIVE_STATES: readonly number[] = [RS.Proposed, RS.Disputed, RS.Review, RS.Open]

type Ev = { chainId: number; block: { number: number; timestamp: number }; logIndex: number; transaction: { hash: string; from?: string } }

/** A row id unique per log. */
export const logId = (e: Ev) => `${e.chainId}-${e.block.number}-${e.logIndex}`
export const ts = (e: Ev) => BigInt(e.block.timestamp)
export const lc = (s: string) => s.toLowerCase()
export const num = (b: bigint) => Number(b)

/** A market seen before its MarketListed log (the oracle initialises it inside createMarket) starts from these. */
export function blankMarket(id: string, e: Ev): Market {
  return {
    id, engine: '', tau: 0n, hasFeed: false, groupId: '', rulesHash: '', specHash: '', gateHash: '', listedAt: ts(e), listedTx: e.transaction.hash,
    state: 0, stateName: STATE[0], live: false, deadline: 0n, haltedAt: undefined, voidDeadline: undefined, oiHaltLots: undefined,
    trustSetId: undefined, requestCount: 0, attempts: 0, proposedOutcome: 0, proposedPath: 0, evidenceHash: undefined, evidenceURI: undefined,
    valueHash: undefined, observedAt: undefined, assertion_id: undefined, rejectedMask: 0, retryOpensAt: undefined, panelNotYet: 0,
    finalOutcome: 0, finalReason: undefined, voidReason: undefined, updatedAt: ts(e),
  }
}

/**
 * The soonest deadline that applies to the market now: a live, undisputed assertion's expiry; in Review after a
 * rejection, when the retry window opens; once halted, voidDeadline; before the halt, tau.
 */
export function deadlineOf(m: Market, a: Assertion | undefined): bigint {
  const candidates: bigint[] = []
  if (m.state === RS.Proposed && a && !a.disputed && !a.settled) candidates.push(a.expiresAt)
  if (m.state === RS.Review && m.retryOpensAt !== undefined) candidates.push(m.retryOpensAt)
  if (m.voidDeadline !== undefined) candidates.push(m.voidDeadline)
  if (candidates.length === 0) return m.tau
  return candidates.reduce((x, y) => (y < x ? y : x))
}

/** The market with its state-derived fields (live, deadline, updatedAt) brought up to date. */
export function refresh(m: Market, a: Assertion | undefined, e: Ev): Market {
  const next = { ...m, stateName: STATE[m.state] ?? String(m.state), live: LIVE_STATES.includes(m.state), updatedAt: ts(e) }
  return { ...next, deadline: deadlineOf(next, a) }
}
