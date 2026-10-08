// Each tick: heartbeat if due, check new proposals (AGREE: done, UNSURE: page, CONTRADICT: dispute once asserted or
// page), then check the float against live bonds.
import type { GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { actOnContradiction, type DisputeResult } from './dispute'
import { beat, FloatWatch, floatStatus } from './heartbeat'
import { Intake } from './intake'
import { checkL1, type L1Deps } from './l1'
import { type CheckModelDeps, checkWithModel } from './model'
import { OUTCOME_NAME, type Page, Path, PATH_NAME, type Proposal, type Verdict, type WatchdogChain } from './types'
import { assertLiveness, DISPUTE_MARGIN_SECS } from './timing'

export type WatchdogDeps = {
  chain: WatchdogChain
  gas: GasTable
  page: Page
  disputeMarginSecs?: bigint
  l1?: L1Deps
  model: CheckModelDeps
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export type Checked = { proposal: Proposal; verdict: Verdict; result?: DisputeResult }
type Pending = { p: Proposal; verdict?: Verdict }

export class Watchdog {
  readonly intake: Intake
  private pending: Pending[] = []
  private readonly floatWatch: FloatWatch

  constructor(private readonly d: WatchdogDeps) {
    this.intake = new Intake(d.chain)
    this.floatWatch = new FloatWatch(d.page)
  }

  check(p: Proposal): Promise<Verdict> {
    return p.path === Path.L1 ? checkL1(p, this.d.chain, this.d.l1) : checkWithModel(p, this.d.chain, { ...this.d.l1, ...this.d.model })
  }

  async tick(): Promise<{ heartbeat: Hex | null; checked: Checked[] }> {
    const log = this.d.log ?? (() => {})
    let heartbeat: Hex | null = null
    try {
      heartbeat = await beat(this.d.chain, this.d.gas)
    } catch (e) {
      await this.d.page({ kind: 'HEARTBEAT_FAILED', detail: String(e) })
    }
    for (const p of await this.intake.next()) this.pending.push({ p })
    const checked: Checked[] = []
    const keep: Pending[] = []
    for (const x of this.pending) {
      try {
        const liveness = await this.d.chain.liveness(x.p.marketId)
        try { assertLiveness(liveness, this.d.disputeMarginSecs ?? DISPUTE_MARGIN_SECS) }
        catch (error) {
          await this.d.page({ kind: 'LIVENESS_INCOMPATIBLE', marketId: x.p.marketId, detail: String(error) })
          continue
        }
        x.verdict ??= await this.check(x.p)
        const v = x.verdict
        const what = `${PATH_NAME[x.p.path]} ${OUTCOME_NAME[x.p.outcome]} on ${x.p.marketId}`
        if (v.kind === 'AGREE') {
          log('info', 'proposal confirmed', { proposal: what, reason: v.reason })
          checked.push({ proposal: x.p, verdict: v })
        } else if (v.kind === 'UNSURE') {
          await this.d.page({ kind: 'UNSURE', marketId: x.p.marketId, detail: `${what}: ${v.reason}`, data: { signals: v.signals } })
          checked.push({ proposal: x.p, verdict: v })
        } else {
          const result = await actOnContradiction(x.p, v, this.d.chain, this.d.gas, this.d.page, this.d.disputeMarginSecs)
          checked.push({ proposal: x.p, verdict: v, result })
          if (result.action === 'WAIT') keep.push(x)
        }
      } catch (e) {
        log('error', 'check failed; retried next tick', { marketId: x.p.marketId, error: String(e) })
        keep.push(x)
      }
    }
    this.pending = keep
    try {
      await this.floatWatch.check(await floatStatus(this.d.chain, this.intake.asserted))
    } catch (e) {
      log('error', 'float check failed', { error: String(e) })
    }
    return { heartbeat, checked }
  }

  async run(pollMs: number, signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        await this.tick()
      } catch (e) {
        ;(this.d.log ?? (() => {}))('error', 'tick failed', { error: String(e) })
      }
      await Bun.sleep(pollMs)
    }
  }
}
