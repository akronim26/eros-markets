// The keeper loop. Each tick reads every market, plans due jobs and sends at most one per market. A job is keyed
// `(marketId, stateVersion, action)` and is sent only if:
//   1. this instance has not already sent the key,
//   2. gas.json has a measured limit for the call (Monad charges the full limit, so it is never guessed),
//   3. a fresh read still shows the planned state version,
//   4. an eth_call neither reverts nor reports that it would change nothing.
// Two instances are safe together: calls are idempotent and the delayed instance drops jobs that went stale. A key
// is forgotten when its transaction reverts or stays unconfirmed past `resendAfterMs`, so lost sends are retried.
// A planner may return fallbacks: each job that would revert or change nothing gives way to the next.
import { type GasTable, gasLimit } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { jobKey, stateVersion } from './version'
import type {
  Chain,
  GlobalPlanner,
  Job,
  JobResult,
  Logger,
  MarketInfo,
  MarketReads,
  MarketSource,
  MarketView,
  Planner,
  ReceiptStatus,
  Resolution,
} from './types'
import { silentLogger } from './types'

export type KeeperOptions = {
  chain: Chain
  source: MarketSource
  planners: Planner[]
  /** Run after the market jobs. */
  globalPlanners?: GlobalPlanner[]
  gas: GasTable
  /** Wait between planning and sending; a second instance uses an offset so it sees the first one's effects. */
  delayMs?: number
  /** A sent key with no receipt after this long is forgotten so the job can be retried. */
  resendAfterMs?: number
  /** Markets read, and jobs executed, in parallel. */
  concurrency?: number
  log?: Logger
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
}

export type TickReport = { markets: number; unreadable: number; results: JobResult[] }

// `hash` is null while the send is in flight. `oracle`: the key's version is the market's resolution (pruned when
// it changes) rather than a job-specific version (pruned after its transaction succeeds).
type Sent = { hash: Hex | null; at: number; oracle: boolean }
type Checked = { job: Job; key: string; gas: bigint }

const defaultNoop = (result: unknown) => result === false

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

export class Keeper {
  private readonly sent = new Map<string, Sent>()
  private readonly infos = new Map<Hex, MarketInfo>()
  private readonly intervals = new Map<number, bigint>()
  private readonly o: Required<Omit<KeeperOptions, 'chain' | 'source' | 'planners' | 'gas' | 'globalPlanners'>> & KeeperOptions

  constructor(opts: KeeperOptions) {
    this.o = {
      delayMs: 0,
      resendAfterMs: 5 * 60_000,
      concurrency: 8,
      log: silentLogger,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      clock: () => Date.now(),
      ...(Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as KeeperOptions), // undefined keeps the default
    }
  }

  sentKeys(): string[] {
    return [...this.sent.keys()]
  }

  async tick(): Promise<TickReport> {
    const { chain, log } = this.o
    await this.reconcile()
    const ids = [...new Set((await this.o.source.marketIds()).map((id) => id.toLowerCase() as Hex))]
    const now = await chain.now()
    const views = await mapLimit(ids, this.o.concurrency, async (id): Promise<MarketView | null> => {
      try {
        const resolution = await chain.getResolution(id)
        const info = await this.info(id)
        return { id, resolution, stateVersion: stateVersion(resolution), now, info, reads: this.reads(id, resolution, info), alert: this.alert(id) }
      } catch (e) {
        log.warn('market unreadable', { marketId: id, error: String(e) })
        return null
      }
    })
    const readable = views.filter((v): v is MarketView => v !== null)
    this.forgetOlderVersions(readable)

    const lists: Job[][] = []
    for (const v of readable) {
      const jobs = await this.plan(v)
      if (jobs.length) lists.push(jobs)
    }
    const globals: Job[] = []
    for (const g of this.o.globalPlanners ?? []) {
      try {
        const reads = { treasury: () => chain.treasuryState(), dispute: (a: Hex) => chain.treasuryDispute(a) }
        globals.push(...(await g({ now, markets: readable, reads, alert: (msg, data = {}) => log.error(msg, { alert: true, ...data }) })))
      } catch (e) {
        log.error('global planner failed', { error: String(e) })
      }
    }
    if ((lists.length || globals.length) && this.o.delayMs > 0) await this.o.sleep(this.o.delayMs)

    // A batchable first job joins its batch; otherwise the market's jobs are tried in order.
    const single = lists.filter((l) => !l[0].batch)
    const batched = new Map<string, Job[]>()
    for (const [j] of lists.filter((l) => l[0].batch)) batched.set(j.batch!.key, [...(batched.get(j.batch!.key) ?? []), j])
    const results = (await mapLimit(single, this.o.concurrency, (l) => this.executeInOrder(l))).flat()
    for (const group of batched.values()) results.push(...(await this.executeBatch(group)))
    for (const j of globals) results.push(await this.execute(j)) // in planned order: closeDispute before skim
    return { markets: ids.length, unreadable: views.length - readable.length, results }
  }

  private async info(id: Hex): Promise<MarketInfo> {
    let i = this.infos.get(id)
    if (!i) {
      i = await this.o.chain.marketInfo(id)
      this.infos.set(id, i)
    }
    return i
  }

  private reads(id: Hex, r: Resolution, info: MarketInfo): MarketReads {
    const { chain } = this.o
    return {
      settlementStatus: () => chain.settlementStatus(info.engine),
      assertionStatus: () => chain.assertionStatus(r.assertionVenue as Hex, r.assertionId as Hex),
      assertionLedger: () => chain.assertionLedger(),
      bondFor: () => chain.bondFor(id),
      groupFinalYes: () => chain.groupFinalYes(info.groupId),
      minRequestIntervalSecs: async () => {
        const v = r.globalsVersion
        let x = this.intervals.get(v)
        if (x === undefined) {
          x = await chain.globalsMinRequestIntervalSecs(v)
          this.intervals.set(v, x)
        }
        return x
      },
    }
  }

  private alert(id: Hex) {
    return (msg: string, data: Record<string, unknown> = {}) => this.o.log.error(msg, { alert: true, marketId: id, ...data })
  }

  /** The jobs of the first planner with any; a planner that throws is logged and skipped. */
  private async plan(v: MarketView): Promise<Job[]> {
    for (const planner of this.o.planners) {
      try {
        const jobs = await planner(v)
        for (const j of jobs) {
          if (j.marketId.toLowerCase() !== v.id || (!j.freshVersion && j.stateVersion !== v.stateVersion)) {
            throw new Error(`planner returned a job for ${j.marketId}@${j.stateVersion}, not the market it was given`)
          }
        }
        if (jobs.length) return jobs
      } catch (e) {
        this.o.log.error('planner failed', { marketId: v.id, error: String(e) })
      }
    }
    return []
  }

  /** Tries a market's jobs in order: one that would revert or change nothing gives way to the next. */
  private async executeInOrder(jobs: Job[]): Promise<JobResult[]> {
    const results: JobResult[] = []
    for (let i = 0; i < jobs.length; i++) {
      const r = await this.execute(jobs[i], i < jobs.length - 1)
      results.push(r)
      if (r.outcome !== 'reverts' && r.outcome !== 'noop') break
    }
    return results
  }

  /** Sends one job if all four checks pass; never throws. */
  async execute(job: Job, fallback = false): Promise<JobResult> {
    const c = await this.check(job, fallback)
    if (!('gas' in c)) return c
    return (await this.send(c.job, [c], c.gas))[0]
  }

  /** Checks each job, then sends the survivors in batch calls of at most `batch.max` (a run of one goes alone). */
  private async executeBatch(group: Job[]): Promise<JobResult[]> {
    const spec = group[0].batch!
    const checked = await mapLimit(group, this.o.concurrency, (j) => this.check(j))
    const results: JobResult[] = checked.filter((c): c is JobResult => !('gas' in c))
    const ok = checked.filter((c): c is Checked => 'gas' in c)
    for (const run of chunks(ok, spec.max)) {
      if (run.length === 1) {
        results.push(...(await this.send(run[0].job, run, run[0].gas)))
        continue
      }
      let gas: bigint
      try {
        gas = spec.gas(this.o.gas, run.length)
      } catch (e) {
        for (const c of run) this.sent.delete(c.key)
        this.o.log.error('no measured gas limit for the batch: not sent', { batch: spec.key, size: run.length })
        results.push(...run.map((c) => ({ key: c.key, job: c.job, outcome: 'no-gas-limit' as const, error: String(e) })))
        continue
      }
      const call: Job = { ...run[0].job, ...spec.call(run.map((c) => c.job.marketId)), action: `${spec.key}-batch`, batch: undefined }
      results.push(...(await this.send(call, run, gas)))
    }
    return results
  }

  /** Claims the job's key if checks 1-4 pass. */
  private async check(job: Job, fallback = false): Promise<Checked | JobResult> {
    const { chain, log } = this.o
    const key = jobKey(job)
    const result = (outcome: JobResult['outcome'], extra: Partial<JobResult> = {}): JobResult => ({ key, job, outcome, ...extra })

    if (this.sent.has(key)) return result('duplicate')
    let gas: bigint
    try {
      gas = gasLimit(this.o.gas, job.gasKey)
    } catch (e) {
      log.error('no measured gas limit: job not sent', { key, gasKey: job.gasKey })
      return result('no-gas-limit', { error: String(e) })
    }
    this.sent.set(key, { hash: null, at: this.o.clock(), oracle: !job.freshVersion }) // before any await, so a concurrent duplicate stops above
    try {
      const fresh = job.freshVersion ? await job.freshVersion() : stateVersion(await chain.getResolution(job.marketId))
      if (fresh !== job.stateVersion) {
        this.sent.delete(key)
        log.info('stale job dropped', { key, now: fresh })
        return result('stale')
      }
      let simulated: unknown
      try {
        simulated = await chain.simulate(job)
      } catch (e) {
        this.sent.delete(key)
        log[fallback ? 'info' : 'warn']('job would revert: not sent', { key, error: String(e) })
        return result('reverts', { error: String(e) })
      }
      if ((job.isNoop ?? defaultNoop)(simulated)) {
        this.sent.delete(key)
        return result('noop')
      }
      return { job, key, gas }
    } catch (e) {
      this.sent.delete(key)
      log.warn('job failed, retried next tick', { key, error: String(e) })
      return result('failed', { error: String(e) })
    }
  }

  private async send(call: Job, members: Checked[], gas: bigint): Promise<JobResult[]> {
    try {
      const hash = await this.o.chain.send(call, gas)
      for (const m of members) this.sent.set(m.key, { hash, at: this.o.clock(), oracle: !m.job.freshVersion })
      this.o.log.info('sent', { keys: members.map((m) => m.key), hash, gas: gas.toString() })
      return members.map((m) => ({ key: m.key, job: m.job, outcome: 'sent' as const, hash }))
    } catch (e) {
      for (const m of members) this.sent.delete(m.key)
      this.o.log.warn('send failed, retried next tick', { keys: members.map((m) => m.key), error: String(e) })
      return members.map((m) => ({ key: m.key, job: m.job, outcome: 'failed' as const, error: String(e) }))
    }
  }

  /** Drops keys whose market has moved to a new state version; they can never be sent again. */
  private forgetOlderVersions(views: MarketView[]) {
    const current = new Map(views.map((v) => [v.id, v.stateVersion.toLowerCase()]))
    for (const [key, s] of this.sent) {
      if (!s.oracle) continue
      const [id, version] = key.split(':')
      const now = current.get(id as Hex)
      if (now !== undefined && now !== version) this.sent.delete(key)
    }
  }

  /** Forgets keys whose transaction reverted, or that have waited past `resendAfterMs` without a receipt. */
  private async reconcile() {
    const t = this.o.clock()
    for (const [key, s] of [...this.sent]) {
      if (s.hash === null) continue
      let status: ReceiptStatus
      try {
        status = await this.o.chain.receiptStatus(s.hash)
      } catch {
        status = 'pending'
      }
      if (status === 'reverted') {
        this.sent.delete(key)
        this.o.log.error('transaction reverted on chain', { key, hash: s.hash })
      } else if (status === 'pending' && t - s.at > this.o.resendAfterMs) {
        this.sent.delete(key)
        this.o.log.warn('no receipt: job may be resent', { key, hash: s.hash })
      } else if (status === 'success' && !s.oracle && t - s.at > this.o.resendAfterMs) {
        this.sent.delete(key) // its own version has moved on; nothing would match this key again
      }
    }
  }

  /** A failed tick is logged and the loop goes on. */
  async run(pollMs: number, signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        const r = await this.tick()
        const sent = r.results.filter((x) => x.outcome === 'sent').length
        this.o.log.info('tick', { markets: r.markets, unreadable: r.unreadable, jobs: r.results.length, sent })
      } catch (e) {
        this.o.log.error('tick failed', { error: String(e) })
      }
      await this.o.sleep(pollMs)
    }
  }
}
