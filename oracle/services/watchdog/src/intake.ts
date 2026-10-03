// Task O35.1: every proposal from every path, as soon as it is recorded (plan §9.2): Layer 1 reports (ProposedL1) and
// panel, committee and permissionless proposals (ProposalRecorded), read from the oracle's logs each tick. A proposal is
// checked once (market, attempt, path, evidence); `Asserted` logs tell the watchdog which assertions are live (float
// accounting, O35.3).
import type { Hex } from 'viem'
import { type Proposal, proposalKey, type WatchdogChain } from './types'

export class Intake {
  private readonly seen = new Set<string>()
  /** marketId → its latest assertionId, from Asserted logs. */
  readonly asserted = new Map<Hex, Hex>()

  constructor(private readonly chain: WatchdogChain) {}

  /** The proposals not seen before, in log order. */
  async next(): Promise<Proposal[]> {
    const { proposals, asserted } = await this.chain.events()
    for (const a of asserted) this.asserted.set(a.marketId.toLowerCase() as Hex, a.assertionId)
    const out: Proposal[] = []
    for (const p of proposals) {
      const k = proposalKey(p)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      out.push(p)
    }
    return out
  }
}
