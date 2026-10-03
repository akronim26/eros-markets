// Heartbeat every 10 minutes (the oracle treats over 15 as stale and switches to reviewed liveness), and an alert when
// WATCHDOG_FLOAT cannot cover a dispute of every live assertion.
import { gasLimit, type GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { type Page, RState, type WatchdogChain } from './types'

export const HEARTBEAT_EVERY_SECS = 600n
export const GAS_HEARTBEAT = 'watchdogHeartbeat'

/** Returns the transaction hash, or null when no heartbeat was due. */
export async function beat(chain: WatchdogChain, gas: GasTable): Promise<Hex | null> {
  const [now, last] = await Promise.all([chain.now(), chain.lastHeartbeat()])
  if (now < last + HEARTBEAT_EVERY_SECS) return null // last = 0: never sent
  return chain.heartbeat(gasLimit(gas, GAS_HEARTBEAT))
}

export type FloatStatus = { float: bigint; liveBonds: bigint; live: { marketId: Hex; assertionId: Hex; bond: bigint }[]; short: boolean }

/** WATCHDOG_FLOAT against the summed bonds of live (undisputed, unsettled, unexpired) assertions. */
export async function floatStatus(chain: WatchdogChain, asserted: ReadonlyMap<Hex, Hex>): Promise<FloatStatus> {
  const now = await chain.now()
  const live: FloatStatus['live'] = []
  for (const [marketId, assertionId] of asserted) {
    const r = await chain.resolution(marketId)
    if (r.state !== RState.Proposed || r.assertionId.toLowerCase() !== assertionId.toLowerCase()) continue
    const st = await chain.assertion(r.assertionVenue, r.assertionId)
    if (st.exists && !st.settled && !st.disputed && now < st.expiresAt) live.push({ marketId, assertionId, bond: st.bond })
  }
  const liveBonds = live.reduce((a, x) => a + x.bond, 0n)
  const float = await chain.floatBalance()
  return { float, liveBonds, live, short: float < liveBonds }
}

/** Alerts once per change in the shortfall, not every tick. */
export class FloatWatch {
  private last = ''
  constructor(private readonly page: Page) {}
  async check(s: FloatStatus) {
    const key = s.short ? `${s.float}:${s.liveBonds}` : ''
    if (key !== this.last && s.short) {
      await this.page({ kind: 'FLOAT_SHORT', detail: `WATCHDOG_FLOAT ${s.float} < Σ live bonds ${s.liveBonds} (${s.live.length} live assertions)`, data: { live: s.live.map((x) => ({ ...x, bond: String(x.bond) })) } })
    }
    this.last = key
  }
}
