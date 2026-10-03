// Task O31.1: the keeper's job loop (plan §9, §9.1). Each tick it lists the markets, reads every `getResolution` at
// `latest`, asks the planners for due jobs and sends at most one job per market. A job is keyed
// `(marketId, stateVersion, action)` and is sent only if, just before sending:
//   1. this instance has not sent (or started sending) the same key,
//   2. gas.json has a measured limit for the call (Monad charges the limit; it is never guessed),
//   3. a fresh read still shows the planned state version (else the job is stale and dropped),
//   4. an eth_call at `latest` neither reverts nor reports that it would change nothing.
// Running two instances is safe: the contract calls are idempotent, a second instance that runs `delayMs` later
// re-reads after the first one's transaction and drops the job as stale, and if both send before either lands,
// the later transaction is a no-op on chain. A sent key is forgotten when its transaction reverts or stays
// unconfirmed past `resendAfterMs`, so a lost transaction is retried.
// O31.2: planners also see the market's listing (read once, it never changes), lazy reads (venue status, treasury,
// globals) and an `alert`; jobs sharing a batch key that pass their checks are sent as one call (finalizeMany).
import { type GasTable, gasLimit } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { jobKey, stateVersion } from './version'
import type {
  Chain,
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
  gas: GasTable
  /** Wait between planning and sending; the second instance runs with an offset so it sees the first's effects. */
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

type Sent = { hash: Hex | null; at: number } // hash null while the send is in flight
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

/** Splits `xs` into runs of at most `n`. */
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

export class Keeper {
  private readonly sent = new Map<string, Sent>()
  private readonly infos = new Map<Hex, MarketInfo>()
  private readonly intervals = new Map<number, bigint>()
  private readonly o: Required<Omit<KeeperOptions, 'chain' | 'source' | 'planners' | 'gas'>> & KeeperOptions

  constructor(opts: KeeperOptions) {
    this.o = {
      delayMs: 0,
      resendAfterMs: 5 * 60_000,
      concurrency: 8,
      log: silentLogger,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      clock: () => Date.now(),
      ...opts,
    }
  }

  /** Keys this instance has sent (or is sending) and still remembers. */
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
        return { id, resolution, stateVersion: stateVersion(resolution), now, info: await this.info(id), reads: this.reads(id, resolution), alert: this.alert(id) }
      } catch (e) {
        log.warn('market unreadable', { marketId: id, error: String(e) })
        return null
      }
    })
    const readable = views.filter((v): v is MarketView => v !== null)
    this.forgetOlderVersions(readable)

    const jobs: Job[] = []
    for (const v of readable) {
      const job = await this.plan(v)
      if (job) jobs.push(job)
    }
    if (jobs.length && this.o.delayMs > 0) await this.o.sleep(this.o.delayMs)

    const single = jobs.filter((j) => !j.batch)
    const batched = new Map<string, Job[]>()
    for (const j of jobs) if (j.batch) batched.set(j.batch.key, [...(batched.get(j.batch.key) ?? []), j])
    const results = await mapLimit(single, this.o.concurrency, (j) => this.execute(j))
    for (const group of batched.values()) results.push(...(await this.executeBatch(group)))
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

  private reads(id: Hex, r: Resolution): MarketReads {
    const { chain } = this.o
    return {
      assertionStatus: () => chain.assertionStatus(r.assertionVenue as Hex, r.assertionId as Hex),
      assertionLedger: () => chain.assertionLedger(),
      bondFor: () => chain.bondFor(id),
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

  /** The first job the planners give for this market; a planner that throws is logged and skipped. */
  private async plan(v: MarketView): Promise<Job | null> {
    for (const planner of this.o.planners) {
      try {
        const jobs = await planner(v)
        for (const j of jobs) {
          if (j.marketId.toLowerCase() !== v.id || j.stateVersion !== v.stateVersion) {
            throw new Error(`planner returned a job for ${j.marketId}@${j.stateVersion}, not the market it was given`)
          }
        }
        if (jobs.length) return jobs[0]
      } catch (e) {
        this.o.log.error('planner failed', { marketId: v.id, error: String(e) })
      }
    }
    return null
  }

  /** Sends one job if all four checks pass; never throws. */
  async execute(job: Job): Promise<JobResult> {
    const c = await this.check(job)
    if (!('gas' in c)) return c
    return (await this.send(c.job, [c], c.gas))[0]
  }

  /**
   * Checks each job on its own, then sends the survivors in runs of at most `batch.max` with the batch call (a
   * run of one is sent as its own job). Every member of a sent run reports the same transaction.
   */
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

  /** Checks 1-4 for one job; claims its key on success (released again on any failure). */
  private async check(job: Job): Promise<Checked | JobResult> {
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
    this.sent.set(key, { hash: null, at: this.o.clock() }) // claimed before any await: a concurrent duplicate stops at the check above
    try {
      const fresh = stateVersion(await chain.getResolution(job.marketId))
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
        log.warn('job would revert: not sent', { key, error: String(e) })
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

  /** Broadcasts `call` for the claimed keys of `members`. */
  private async send(call: Job, members: Checked[], gas: bigint): Promise<JobResult[]> {
    try {
      const hash = await this.o.chain.send(call, gas)
      for (const m of members) this.sent.set(m.key, { hash, at: this.o.clock() })
      this.o.log.info('sent', { keys: members.map((m) => m.key), hash, gas: gas.toString() })
      return members.map((m) => ({ key: m.key, job: m.job, outcome: 'sent' as const, hash }))
    } catch (e) {
      for (const m of members) this.sent.delete(m.key)
      this.o.log.warn('send failed, retried next tick', { keys: members.map((m) => m.key), error: String(e) })
      return members.map((m) => ({ key: m.key, job: m.job, outcome: 'failed' as const, error: String(e) }))
    }
  }

  /** Keys of a market whose state version has changed can never be sent again; drop them. */
  private forgetOlderVersions(views: MarketView[]) {
    const current = new Map(views.map((v) => [v.id, v.stateVersion.toLowerCase()]))
    for (const key of this.sent.keys()) {
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
      }
    }
  }

  /** Ticks every `pollMs` until `signal` aborts; a failed tick is logged and the loop goes on. */
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
