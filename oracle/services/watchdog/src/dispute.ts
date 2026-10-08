// On a contradiction, disputes via BondTreasury (bond from WATCHDOG_FLOAT) and pages, while the assertion is live and
// before `expiresAt − margin` (600 s by default; explicit Monad testnet override). Without float, too late, or at the open-dispute limit, it only pages. An unasserted
// proposal is waited for.
import { gasLimit, type GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { OUTCOME_NAME, type Page, PATH_NAME, type Proposal, RState, type Verdict, type WatchdogChain } from './types'
import { assertLiveness, DISPUTE_MARGIN_SECS } from './timing'

export { DISPUTE_MARGIN_SECS } from './timing'
export const GAS_DISPUTE = 'disputeViaVenue'

export type DisputeResult =
  | { action: 'DISPUTED'; hash: Hex }
  | { action: 'WAIT'; reason: string }
  | { action: 'PAGED'; reason: string }

export async function actOnContradiction(p: Proposal, v: Verdict, chain: WatchdogChain, gas: GasTable, page: Page, margin = DISPUTE_MARGIN_SECS): Promise<DisputeResult> {
  const id = p.marketId
  const what = `${PATH_NAME[p.path]} proposal ${OUTCOME_NAME[p.outcome]} on ${id}`
  const pageOnly = async (reason: string): Promise<DisputeResult> => {
    await page({ kind: 'CONTRADICTION', marketId: id, detail: `${what} contradicted (${v.reason}); not disputed: ${reason}`, data: { signals: v.signals } })
    return { action: 'PAGED', reason }
  }
  const r = await chain.resolution(id)
  const liveness = await chain.liveness(id)
  try { assertLiveness(liveness, margin) }
  catch (error) { return pageOnly(error instanceof Error ? error.message : 'liveness validation failed') }
  if (r.state !== RState.Proposed && r.state !== RState.Disputed) return pageOnly(`the market is no longer Proposed (state ${r.state})`)
  if (r.proposed !== p.outcome || r.path !== p.path || r.evidenceHash.toLowerCase() !== p.evidenceHash.toLowerCase()) return pageOnly('the market now carries another proposal')
  if (r.assertionId === `0x${'00'.repeat(32)}`) return { action: 'WAIT', reason: 'not asserted yet' }
  const st = await chain.assertion(r.assertionVenue, r.assertionId)
  if (st.disputed || r.state === RState.Disputed) return pageOnly('already disputed')
  if (!st.exists || st.settled) return pageOnly('the assertion is settled')
  const now = await chain.now()
  if (now >= st.expiresAt - margin) return pageOnly(`too late: within ${margin} s of expiresAt ${st.expiresAt}`)
  if ((await chain.watchdogOf(id)).toLowerCase() !== chain.address.toLowerCase()) return pageOnly('this key is not the market’s watchdog (revoked or another trust set)')
  const float = await chain.floatBalance()
  if (float < st.bond) return pageOnly(`WATCHDOG_FLOAT ${float} is below the bond ${st.bond}`)
  const d = await chain.openDisputes()
  if (d.open >= d.max) return pageOnly(`the treasury's open-dispute limit (${d.max}) is reached`)
  let limit: bigint
  try {
    limit = gasLimit(gas, GAS_DISPUTE)
  } catch {
    return pageOnly(`no gas.json limit for ${GAS_DISPUTE}`)
  }
  try {
    await chain.simulateDispute(id)
  } catch (e) {
    return pageOnly(`disputeViaVenue would revert: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
  // RPC/simulation latency must not consume the remaining safety margin unnoticed.
  if (await chain.now() >= st.expiresAt - margin) return pageOnly(`too late: within ${margin} s after simulation`)
  const hash = await chain.dispute(id, limit)
  await page({ kind: 'DISPUTED', marketId: id, detail: `${what} disputed with the float (${v.reason}); tx ${hash}`, data: { signals: v.signals, bond: String(st.bond) } })
  return { action: 'DISPUTED', hash }
}
