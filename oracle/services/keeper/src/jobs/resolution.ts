// Resolution jobs in priority order. Each condition mirrors ResolutionOracle's own check; the eth_call before
// sending has the final word.
//
//   void         not Final, now >= voidDeadline                          voidMarket (voidMarketStuck with a live assertion)
//   halt         pre-halt (None, EarlyCheck, EarlyReview), now >= T     haltScheduled
//   expire early EarlyCheck/EarlyReview, now >= earlyStartedAt + TTL    expireEarly
//   escalate     L1Pending, now >= T + l1TimeoutSecs                     escalateToL2
//   request L1   L1Pending, feed, now >= T + bufferSecs, every 5 min     requestResolution (onchain floor: minRequestIntervalSecs)
//   open         L2Pending/Review, now >= T and >= retryOpensAt or l2StartedAt + l2DeadlineSecs   openAfterDeadline
//   assert       Proposed, no live assertion, the ASSERTION ledger holds the bond (else alert)   assertProposal
//   conflict     Proposed YES in an exclusive group that already has a Final YES                  assertProposal
//                (it moves the market to Review and returns false, so false is not a no-op here)
//   sync dispute Proposed, the venue shows the assertion disputed and unsettled                   syncAssertion
//   finalize     Proposed past expiresAt or settled on the venue; Disputed (the DVM may have answered)
//                finalizeMarket, or KeeperRouter.finalizeMany for up to 4 markets in one tick
import { gasLimit, type GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import type { Batch, Job, MarketView, Planner, Target } from '../types'

/** RState (OracleTypes.sol); values are ABI. */
export const RState = {
  None: 0, EarlyCheck: 1, EarlyReview: 2, L1Pending: 3, L2Pending: 4, Review: 5, Open: 6, Proposed: 7, Disputed: 8, Voided: 9, Final: 10,
} as const

/** FinalizeStatus (OracleTypes.sol). */
export const FinalizeStatus = { NOT_READY: 0, FINAL: 1, REJECTED: 2, DISPUTED: 3 } as const

const A_MAX = 3
const OUTCOME_YES = 1 // Outcome.YES
const ZERO32 = `0x${'00'.repeat(32)}`
export const REQUEST_EVERY_SECS = 300n // the contract's own floor is minRequestIntervalSecs
export const FINALIZE_BATCH_MAX = 4 // finalizeMany4 is the largest batch measured

export type ResolutionPlannerOptions = {
  requestEverySecs?: bigint
}

/** `finalizeMany1.limit + (k - 1) × finalizeMany4.perExtraMarket`. */
export function finalizeManyGas(table: GasTable, k: number): bigint {
  if (!Number.isInteger(k) || k < 1 || k > FINALIZE_BATCH_MAX) throw new RangeError(`finalizeMany batch of ${k} is not measured`)
  const per = (table.calls.finalizeMany4 as { perExtraMarket?: unknown } | undefined)?.perExtraMarket
  if (typeof per !== 'number') throw new Error('gas.json has no finalizeMany4.perExtraMarket')
  return gasLimit(table, 'finalizeMany1') + BigInt(k - 1) * BigInt(per)
}

export const FINALIZE_BATCH: Batch = {
  key: 'finalize',
  max: FINALIZE_BATCH_MAX,
  call: (ids: Hex[]) => ({ target: 'KeeperRouter', functionName: 'finalizeMany', args: [ids] }),
  gas: finalizeManyGas,
}

export function resolutionPlanner(opts: ResolutionPlannerOptions = {}): Planner {
  const every = opts.requestEverySecs ?? REQUEST_EVERY_SECS

  return async (v: MarketView): Promise<Job[]> => {
    const realEngine = v.engineIdentity.kind === 'book-risk'
    const engine = realEngine ? 'RealEngine' : ''
    const { resolution: r, info, now } = v
    const job = (action: string, functionName: string, gasKey: string, extra: Partial<Job> = {}, target: Target = 'ResolutionOracle'): Job[] => [
      { marketId: v.id, stateVersion: v.stateVersion, action, target, functionName, args: [v.id], gasKey, ...extra },
    ]
    const s = r.state
    const live = r.assertionId !== ZERO32

    if (s !== RState.Final && r.voidDeadline !== 0n && now >= r.voidDeadline) {
      return job('void', 'voidMarket', `${live ? 'voidMarketStuck' : 'voidMarket'}${engine}`)
    }
    if (s === RState.None || s === RState.EarlyCheck || s === RState.EarlyReview) {
      if (now >= info.tau) return job('halt', 'haltScheduled', `haltScheduled${engine}`)
      if (s !== RState.None && now >= r.earlyStartedAt + info.earlyTtlSecs) return job('expire-early', 'expireEarly', 'expireEarly')
      return []
    }
    if (s === RState.L1Pending) {
      if (now >= info.tau + info.l1TimeoutSecs) return job('escalate', 'escalateToL2', 'escalateToL2')
      if (!info.hasFeed || now < info.tau + info.bufferSecs) return []
      const floor = await v.reads.minRequestIntervalSecs()
      const interval = every > floor ? every : floor
      if (r.lastRequestAt !== 0n && now < r.lastRequestAt + interval) return []
      return job('request', 'requestResolution', 'requestResolution')
    }
    if (s === RState.L2Pending || s === RState.Review) {
      if (now < info.tau) return [] // an early-halted market stays committee-only until T
      const opensAt = r.retryOpensAt !== 0n ? r.retryOpensAt : r.l2StartedAt + info.l2DeadlineSecs
      return now >= opensAt ? job('open', 'openAfterDeadline', 'openAfterDeadline') : []
    }
    if (s === RState.Proposed && !live) {
      if (r.proposed === OUTCOME_YES && info.groupExclusive && info.groupId !== ZERO32 && (await v.reads.groupFinalYes()) !== ZERO32) {
        return job('group-conflict', 'assertProposal', 'assertProposal', { isNoop: () => false })
      }
      if (r.attempts >= A_MAX) {
        v.alert('Proposed with every assertion attempt used', { attempts: r.attempts })
        return []
      }
      const [have, bond] = await Promise.all([v.reads.assertionLedger(), v.reads.bondFor()])
      if (have < bond) {
        v.alert('treasury short: the ASSERTION ledger cannot fund the bond', { have: have.toString(), bond: bond.toString() })
        return []
      }
      // The limit covers a 16 KiB claim: the keeper does not know the claim length in advance (gas.json).
      return job('assert', 'assertProposal', 'assertProposal')
    }
    if ((s === RState.Proposed || s === RState.Disputed) && live) {
      const st = await v.reads.assertionStatus()
      if (s === RState.Proposed && st.disputed && !st.settled) return job('sync', 'syncAssertion', 'syncAssertion')
      if (s === RState.Disputed || st.settled || now >= st.expiresAt) {
        // From Disputed, an unsettled dispute returns DISPUTED again: nothing to send.
        const isNoop = (res: unknown) =>
          res === FinalizeStatus.NOT_READY || (s === RState.Disputed && res === FinalizeStatus.DISPUTED)
        return job('finalize', 'finalizeMarket', `finalizeMarket${engine}`, { isNoop, batch: realEngine ? undefined : FINALIZE_BATCH })
      }
    }
    return []
  }
}
