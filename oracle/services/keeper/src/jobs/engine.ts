// Task O31.3: engine follow-up after Final (plan §9.1 "courtesy; owned by Risk", §3.2). Claims open only through
// Risk's permissionless, chunked preparation (SettlementController): the price for INVALID is captured, the
// frozen snapshot and the payouts are prepared 32 accounts at a time, then `finishPreparation` enables claims.
// The keeper reads the engine's `getSettlementStatus()` and offers, in order:
//
//   INVALID without a captured price      captureInvalidPrice()   (a capture that is not possible yet is a no-op)
//   otherwise                             finishPreparation(), then preparePayoutChunk(32), then prepareSnapshotChunk(32)
//
// The core tries them in that order and sends the first that would not revert: finishing reverts until both jobs
// are done, a payout chunk reverts until the snapshot is done, so the one sent is always the next step. Nothing
// is planned once claims are enabled (the testnet stub engine reports that as soon as the outcome is final), and
// RECOVERY_REQUIRED is an alert for Risk, not a job. The job's version is the engine status, so each chunk is a
// new key and a chunk is never sent twice for the same progress.
//
// Gas: the four calls have no gas.json entry yet. Their cost depends on Person A's accounting (32 accounts per
// chunk), which the oracle's seam harness only mocks, so they are measured at the risk merge; until then the
// keeper refuses them ("no measured gas limit") rather than guess.
import { encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from 'viem'
import { EngineOutcome } from '../engineAbi'
import type { Job, MarketView, Planner, SettlementStatus } from '../types'
import { RState } from './resolution'

export const CHUNK = 32n // SettlementController.MAX_CHUNK; plan §9.1 "(32)"

const VERSION_TYPES = parseAbiParameters('bytes32, bool, uint8, bool, uint64, uint64, uint64, bool, bool, bool')

/** The engine-progress version of a market: its oracle version and every status field the jobs depend on. */
export function engineVersion(oracleVersion: Hex, s: SettlementStatus): Hex {
  return keccak256(
    encodeAbiParameters(VERSION_TYPES, [
      oracleVersion, s.halted, s.finalOutcome, s.invalidPriceReady, s.snapshotCursor, s.payoutCursor, s.accountCount,
      s.claimsEnabled, s.accountingComplete, s.recoveryRequired,
    ]),
  )
}

export function enginePlanner(): Planner {
  return async (v: MarketView): Promise<Job[]> => {
    if (v.resolution.state !== RState.Final) return []
    const st = await v.reads.settlementStatus()
    if (st.claimsEnabled || !st.halted) return []
    if (st.recoveryRequired) {
      v.alert('engine RECOVERY_REQUIRED: claims stay disabled (Risk on-call)', { engine: v.info.engine })
      return []
    }
    const version = engineVersion(v.stateVersion, st)
    const freshVersion = async () => engineVersion(v.stateVersion, await v.reads.settlementStatus())
    const job = (action: string, functionName: string, args: readonly unknown[], gasKey: string, isNoop: Job['isNoop']): Job => ({
      marketId: v.id, stateVersion: version, action, target: 'Engine', address: v.info.engine, functionName, args, gasKey, isNoop, freshVersion,
    })
    if (st.finalOutcome === EngineOutcome.INVALID && !st.invalidPriceReady) {
      // (status, captured): not captured means the window is incomplete and the grace has not run out, or BLOCKED.
      return [job('capture-invalid-price', 'captureInvalidPrice', [], 'captureInvalidPrice', (r) => !(r as readonly [number, boolean])[1])]
    }
    const never = () => false // each of these either reverts (not the next step) or makes progress
    return [
      job('finish-preparation', 'finishPreparation', [], 'finishPreparation', never),
      job('payout-chunk', 'preparePayoutChunk', [CHUNK], 'preparePayoutChunk32', never),
      job('snapshot-chunk', 'prepareSnapshotChunk', [CHUNK], 'prepareSnapshotChunk32', never),
    ]
  }
}
