// Engine follow-up after Final: drives the Risk engine's chunked settlement preparation until claims open.
//
//   INVALID without a captured price   captureInvalidPrice()
//   otherwise                          finishPreparation(), preparePayoutChunk(32), prepareSnapshotChunk(32)
//
// The keeper sends the first that would not revert; each reverts until the step before it is done, so the one sent
// is always the next step. The job version is the engine status, so no chunk is sent twice. RECOVERY_REQUIRED is
// an alert, not a job.
//
// These calls have no gas.json entry until they are measured against the real engine; until then the keeper
// refuses to send them.
import { encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from 'viem'
import { EngineOutcome } from '../engineAbi'
import type { Job, MarketView, Planner, SettlementStatus } from '../types'
import { RState } from './resolution'

export const CHUNK = 32n // SettlementController.MAX_CHUNK

const VERSION_TYPES = parseAbiParameters('bytes32, bool, uint8, bool, uint64, uint64, uint64, bool, bool, bool')

/** Hash of the oracle version and every settlement field the jobs depend on. */
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
    if (v.engineIdentity.kind !== 'book-risk' || v.resolution.state !== RState.Final) return []
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
