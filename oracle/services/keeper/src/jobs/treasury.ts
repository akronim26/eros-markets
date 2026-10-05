// Treasury jobs, which belong to no single market.
//
//   close dispute   a dispute BondTreasury funded (DisputeFunded) is still open; the treasury closes it once the
//                   venue settled the assertion or the market is Final with VOID_DEADLINE (else the call returns
//                   false: a no-op)                                                   closeDispute(assertionId)
//   skim            after the closes, USDC no ledger accounts for (dispute winnings, donations) is credited to
//                   WATCHDOG_FLOAT (a zero credit is a no-op)                          skim()
//   commitments     hourly, no transaction: alert when the ASSERTION ledger is below the listings' commitments
//                   (totalCommitted) or below the next bond a Proposed market will need
import { encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from 'viem'
import type { DisputeSource, GlobalPlanner, Job } from '../types'
import { RState } from './resolution'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`
export const COMMITMENTS_EVERY_SECS = 3600n

const disputeVersion = (assertionId: Hex, venue: Hex) =>
  keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address'), [assertionId, venue]))

/** closeDispute for every open treasury dispute, then skim. A dispute seen closed is not read again. */
export function treasuryPlanner(disputes: DisputeSource): GlobalPlanner {
  const closed = new Set<string>()
  return async (g) => {
    const jobs: Job[] = []
    for (const assertionId of await disputes.assertionIds()) {
      if (closed.has(assertionId.toLowerCase())) continue
      const d = await g.reads.dispute(assertionId)
      if (d.venue.toLowerCase() === ZERO_ADDRESS) {
        closed.add(assertionId.toLowerCase())
        continue
      }
      jobs.push({
        marketId: d.marketId,
        stateVersion: disputeVersion(assertionId, d.venue),
        action: `close-dispute:${assertionId.toLowerCase()}`,
        target: 'BondTreasury',
        functionName: 'closeDispute',
        args: [assertionId],
        gasKey: 'closeDispute',
        freshVersion: async () => disputeVersion(assertionId, (await g.reads.dispute(assertionId)).venue),
      })
    }
    const t = await g.reads.treasury()
    const skimVersion = (s: typeof t) =>
      keccak256(encodeAbiParameters(parseAbiParameters('uint256, uint256, uint32'), [s.usdcBalance, s.watchdogFloat, s.openDisputes]))
    jobs.push({
      marketId: ZERO32, // no market: the treasury as a whole
      stateVersion: skimVersion(t),
      action: 'skim',
      target: 'BondTreasury',
      functionName: 'skim',
      args: [],
      gasKey: 'skim',
      isNoop: (credited) => credited === 0n,
      freshVersion: async () => skimVersion(await g.reads.treasury()),
    })
    return jobs
  }
}

/** Hourly: the ASSERTION ledger against the listings' commitments and the next bond. Sends nothing. */
export function commitmentsCheck(everySecs = COMMITMENTS_EVERY_SECS): GlobalPlanner {
  let last: bigint | undefined
  return async (g) => {
    if (last !== undefined && g.now < last + everySecs) return []
    last = g.now
    const t = await g.reads.treasury()
    const waiting = g.markets.filter((m) => m.resolution.state === RState.Proposed && m.resolution.assertionId === ZERO32)
    let nextBond = 0n
    for (const m of waiting) {
      const b = await m.reads.bondFor()
      if (b > nextBond) nextBond = b
    }
    if (t.assertionLedger < t.totalCommitted) {
      g.alert('ASSERTION ledger below the listings\' commitments', { ledger: t.assertionLedger.toString(), committed: t.totalCommitted.toString() })
    }
    if (t.assertionLedger < nextBond) {
      g.alert('ASSERTION ledger below the next bond', { ledger: t.assertionLedger.toString(), nextBond: nextBond.toString() })
    }
    return []
  }
}
