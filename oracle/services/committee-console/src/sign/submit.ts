// Task O34.2: submission (plan §8.4: "submitted by anyone"). The bundle must be current (staleness) and carry the
// threshold of valid member signatures; the first `threshold` of them, ascending by signer, are sent. Gas comes from
// deployments/gas.json: `submitReviewedProposal` was measured with up to three EOA signatures; a contract member's
// ERC-1271 check is not measured, so a bundle that needs one is not sent (its key is absent) — the same rule as the
// panel runner's unmeasured route.
import { gasLimit, type GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import type { CaseChain } from '../backend/types'
import { type Bundle, ProposalError } from './bundle'
import { collect, staleness } from './collect'

export const GAS_KEY = 'submitReviewedProposal'
export const GAS_KEY_ERC1271 = 'submitReviewedProposalERC1271'
/** The most signatures gas.json's measurement covers. */
export const MEASURED_SIGNATURES = 3

export async function submitBundle(b: Bundle, chain: CaseChain, gas: GasTable): Promise<Hex> {
  const stale = await staleness(b, chain)
  if (stale.length > 0) throw new ProposalError(`not current: ${stale.join('; ')}`)
  const c = await collect(b, chain)
  if (!c.enough) throw new ProposalError(`${c.valid.length} valid signature(s), threshold ${c.threshold}`)
  const sigs = c.valid.slice(0, c.threshold)
  if (sigs.length > MEASURED_SIGNATURES) throw new ProposalError(`threshold ${c.threshold} is above the ${MEASURED_SIGNATURES} signatures gas.json measured`)
  const erc1271 = c.checks.some((x) => x.kind === 'ERC1271' && sigs.some((s) => s.signer === x.signer))
  const key = erc1271 ? GAS_KEY_ERC1271 : GAS_KEY
  let limit: bigint
  try {
    limit = gasLimit(gas, key)
  } catch {
    throw new ProposalError(`no gas.json limit for ${key}: not sent`)
  }
  await chain.simulateReviewed(b.proposal.marketId, b.proposal, b.evidenceURI, sigs) // a revert throws: nothing is sent
  return chain.sendReviewed(b.proposal.marketId, b.proposal, b.evidenceURI, sigs, limit)
}
