// New proposals from every path, each returned once per (market, attempt, path, evidence), and the latest assertion
// per market for float accounting.
import type { Hex } from 'viem'
import { type Proposal, proposalKey, type WatchdogChain } from './types'

export class Intake {
  private readonly seen = new Set<string>()
  /** marketId → latest assertionId. */
  readonly asserted = new Map<Hex, Hex>()

  constructor(private readonly chain: WatchdogChain) {}

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
