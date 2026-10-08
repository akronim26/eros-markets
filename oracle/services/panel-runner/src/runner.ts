// The panel runner loop. A market enters the panel in EarlyCheck (before T) or L2Pending (after T); the runner learns
// this from StateChanged logs and re-reads every market it has seen in case a log was missed. One run:
//   1. check the market pins this runner's models, prompt and calibration (else alert and skip)
//   2. take a fresh snapshot and keep it under its evidenceHash
//   3. scan for injection, ask the models, calibrate; keep `<evidenceHash>.panel.json` for the committee console
//   4. pre-check the route to save gas (the contract decides): a NOT_YET majority after T is not sent and re-runs
//      after 15 min, 30 min, 1 h, … until the L2 deadline
//   5. sign the PanelResult, eth_call it, journal/send with the measured gas limit, and reconcile finalized acceptance
import { gasLimit, type GasTable, type ModelCall, modelIdHash, type PanelResult } from '@eros-oracle/oracle-sdk'
import { canonicalBytes, evidenceHash, type Item, type Snapshot, type SnapshotRequest } from '@eros-oracle/snapshotter'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, keccak256, stringToBytes } from 'viem'
import { type CalibrationMap, type Candidate, calibrate, calibratorHash, candidate } from './calibration'
import type { Scan } from './injection'
import type { ModelOutcome } from './models/client'
import { buildCall, type PinnedPrompt, promptFor } from './prompts'
import { type DigestSigner, signPanelResult } from './signer'
import { SubmissionStore } from './submissions'

export const RState = { None: 0, EarlyCheck: 1, EarlyReview: 2, L1Pending: 3, L2Pending: 4, Review: 5 } as const
export const Phase = { EARLY: 1, POST_T: 2 } as const
export const LABEL = { ABSTAIN: 0, YES: 1, NO: 2, INVALID: 3, NOT_YET: 4 } as const
export const RERUN_FIRST_SECS = 15n * 60n // then doubling
export const SIGNATURE_TTL_SECS = 3600n
export const GAS_KEY = 'submitPanelResult'
export const GAS_KEY_AUTO = 'submitPanelResultAutoPropose'

export type AIConfig = { modelIdHashes: readonly Hex[]; promptHash: Hex; calibratorHash: Hex; categoryId: Hex; highConfBps: number }
export type MarketView = {
  state: number
  attempts: number
  trustSetId: number
  l2StartedAt: bigint
  earlyStartedAt: bigint
  tau: bigint
  hasFeed: boolean
  gateHash: Hex
  l2DeadlineSecs: bigint
  earlyTtlSecs: bigint
}

export type PanelChain = {
  chainId: number
  oracle: Address
  now(): Promise<bigint>
  /** StateChanged logs since the last call. */
  stateChanges(): Promise<{ id: Hex; to: number }[]>
  market(id: Hex): Promise<MarketView>
  aiConfig(id: Hex): Promise<AIConfig>
  text(id: Hex): Promise<{ question: string; rules: string }>
  l1Url(id: Hex): Promise<string | undefined>
  allowList(id: Hex): Promise<string[]>
  activeTrustSetId(): Promise<number>
  categoryValidated(categoryId: Hex, gateHash: Hex): Promise<boolean>
  /** Returns the state it routes to; throws with the revert. */
  simulate(id: Hex, r: PanelResult, uri: string, sig: Hex): Promise<number>
  send(id: Hex, r: PanelResult, uri: string, sig: Hex, gas: bigint): Promise<Hex>
  /** Only confirmed after canonical finality, successful execution and a matching acceptance event. */
  submissionStatus(hash: Hex, id: Hex, phase: number, evidenceHash: Hex): Promise<'pending' | 'reverted' | 'confirmed'>
}

export type Route = 'EarlyReview' | 'None' | 'Review' | 'AutoPropose' | 'NotYet'

export type RunResult = {
  id: Hex
  phase: number
  route: Route
  evidenceHash: Hex
  evidenceURI: string
  outcomes: ModelOutcome[]
  calibratedBps: number[]
  scan: Scan
  sent?: Hex
  confirmed?: boolean
  skipped?: string
}

/** `<evidenceHash>.panel.json`, for the committee console. Not hashed or signed. */
export type PanelRecord = {
  version: 1
  marketId: Hex
  phase: number
  evidenceHash: Hex
  evidenceURI: string
  outcomes: { model: string; label: string; labelCode: number; confidence: number | null; cited: number[]; rationale: string; abstainReason?: string }[]
  calibratedBps: number[]
  flags: number
  findings: Scan['findings']
  candidate: Candidate
}

export type RunnerDeps = {
  chain: PanelChain
  signer: DigestSigner
  prompts: readonly PinnedPrompt[]
  /** A market's modelIdHashes pick three of these. */
  models: readonly string[]
  maps: readonly CalibrationMap[]
  gas: GasTable
  takeSnapshot(req: SnapshotRequest): Promise<Snapshot>
  scan(snapshot: Snapshot, prompt: PinnedPrompt): Promise<Scan>
  askPanel(models: readonly string[], call: ModelCall, items: readonly Item[]): Promise<ModelOutcome[]>
  /** Extra evidence pages per market. */
  pagesFor?(id: Hex): string[]
  snapshotDir: string
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export class RunnerConfigError extends Error {}

const quiet = () => {}

/** In modelIdHashes order; throws when one is not configured. */
export function pinnedModels(ai: AIConfig, models: readonly string[]): string[] {
  return ai.modelIdHashes.map((h) => {
    const m = models.find((x) => modelIdHash(x) === h.toLowerCase())
    if (!m) throw new RunnerConfigError(`modelIdHash ${h} is not one of the configured models`)
    return m
  })
}

const unanimousKnown = (labels: number[]) => labels[0] === labels[1] && labels[1] === labels[2] && [LABEL.YES, LABEL.NO, LABEL.INVALID].includes(labels[0] as 1 | 2 | 3)
const unanimousBinary = (labels: number[]) => labels[0] === labels[1] && labels[1] === labels[2] && (labels[0] === LABEL.YES || labels[0] === LABEL.NO)
const watchKey = (m: MarketView) => m.state === RState.EarlyCheck ? `early:${m.earlyStartedAt}` : `l2:${m.l2StartedAt}:${m.attempts}`

/** The contract's expected route, used only to save gas. */
export function preRoute(phase: number, labels: number[], bps: number[], flags: number, ai: AIConfig, categoryValidated: boolean): Route {
  if (phase === Phase.EARLY) return flags !== 0 || (unanimousKnown(labels) && bps.every((b) => b >= ai.highConfBps)) ? 'EarlyReview' : 'None'
  if (labels.filter((l) => l === LABEL.NOT_YET).length >= 2) return 'NotYet'
  const couldAuto = flags === 0 && categoryValidated && unanimousBinary(labels) && bps.every((b) => b >= ai.highConfBps)
  return couldAuto ? 'AutoPropose' : 'Review'
}

export async function runOnce(id: Hex, d: RunnerDeps): Promise<RunResult | null> {
  const log = d.log ?? quiet
  const c = d.chain
  const store = new SubmissionStore(d.snapshotDir, c.chainId, c.oracle)
  const previous = store.read(id)
  if (previous?.status === 'broadcasting') throw new Error('Panel broadcast outcome unknown; reconcile the submission journal before retrying')
  if (previous?.status === 'pending') {
    const status = await c.submissionStatus(previous.result.sent!, id, previous.result.phase, previous.result.evidenceHash)
    if (status === 'pending') return previous.result
    store.write(id, { ...previous, status, result: { ...previous.result, confirmed: status === 'confirmed' } })
    if (status === 'reverted') throw new Error('Panel transaction reverted; a fresh run will retry')
    return { ...previous.result, confirmed: true }
  }
  const m = await c.market(id)
  const phase = m.state === RState.EarlyCheck ? Phase.EARLY : m.state === RState.L2Pending ? Phase.POST_T : 0
  if (phase === 0) return null
  const keyForEntry = watchKey(m)
  if (previous?.status === 'confirmed' && previous.key === keyForEntry) return previous.result
  const ai = await c.aiConfig(id)
  const models = pinnedModels(ai, d.models)
  const prompt = promptFor(d.prompts, ai.categoryId, ai.promptHash)
  const maps = models.map((model) => {
    const map = d.maps.find((x) => x.model === model)
    if (!map) throw new RunnerConfigError(`no calibration map for ${model}`)
    return map
  })
  if (calibratorHash(maps) !== ai.calibratorHash.toLowerCase()) throw new RunnerConfigError(`the market pins calibratorHash ${ai.calibratorHash}; these maps hash to ${calibratorHash(maps)}`)

  const snapshot = await d.takeSnapshot({ marketId: id, l1Url: m.hasFeed ? await c.l1Url(id) : undefined, allowList: await c.allowList(id), pages: d.pagesFor?.(id) ?? [] })
  const evHash = evidenceHash(snapshot)
  mkdirSync(d.snapshotDir, { recursive: true })
  writeFileSync(join(d.snapshotDir, `${evHash}.json`), canonicalBytes(snapshot))
  const uri = `eros-snapshot:${evHash}`

  const scan = await d.scan(snapshot, prompt)
  const outcomes = await d.askPanel(models, buildCall(prompt, { ...(await c.text(id)), tau: m.tau }, snapshot), snapshot.items)
  const bps = calibrate(outcomes, maps)
  const labels = outcomes.map((o) => o.labelCode)
  const record: PanelRecord = {
    version: 1,
    marketId: id,
    phase,
    evidenceHash: evHash,
    evidenceURI: uri,
    outcomes: outcomes.map((o) => ({ model: o.model, label: o.label, labelCode: o.labelCode, confidence: o.confidence, cited: o.cited, rationale: o.rationale, ...(o.abstainReason ? { abstainReason: o.abstainReason } : {}) })),
    calibratedBps: bps,
    flags: scan.flags,
    findings: scan.findings,
    candidate: candidate(outcomes, bps),
  }
  writeFileSync(join(d.snapshotDir, `${evHash}.panel.json`), JSON.stringify(record, null, 2) + '\n')
  const validated = phase === Phase.POST_T && (await c.categoryValidated(ai.categoryId, m.gateHash))
  const route = preRoute(phase, labels, bps, scan.flags, ai, validated)
  const base: RunResult = { id, phase, route, evidenceHash: evHash, evidenceURI: uri, outcomes, calibratedBps: bps, scan }
  if (route === 'NotYet') return { ...base, skipped: 'NOT_YET majority: the market stays in L2Pending' }
  const key = route === 'AutoPropose' ? GAS_KEY_AUTO : GAS_KEY
  let gas: bigint
  try {
    gas = gasLimit(d.gas, key)
  } catch {
    log('error', 'no measured gas limit for this route: not sent', { marketId: id, route, gasKey: key })
    return { ...base, skipped: `no gas.json limit for ${key}` }
  }

  const result: PanelResult = {
    marketId: id,
    phase,
    attempt: m.attempts,
    labels: labels as [number, number, number],
    calibratedBps: bps as [number, number, number],
    evidenceHash: evHash,
    evidenceURIHash: keccak256(stringToBytes(uri)),
    gateHash: m.gateHash,
    flags: scan.flags,
    trustSetId: phase === Phase.EARLY ? await c.activeTrustSetId() : m.trustSetId,
    deadline: (await c.now()) + SIGNATURE_TTL_SECS,
  }
  const { signature } = await signPanelResult(d.signer, c.chainId, c.oracle, result)
  await c.simulate(id, result, uri, signature)
  store.write(id, { key: keyForEntry, status: 'broadcasting', result: base })
  const sent = await c.send(id, result, uri, signature, gas)
  const pending = { ...base, sent }
  store.write(id, { key: keyForEntry, status: 'pending', result: pending })
  log('info', 'panel result sent', { marketId: id, route, hash: sent, flags: scan.flags, labels })
  const status = await c.submissionStatus(sent, id, phase, evHash)
  if (status !== 'pending') store.write(id, { key: keyForEntry, status, result: { ...pending, confirmed: status === 'confirmed' } })
  if (status === 'reverted') throw new Error('Panel transaction reverted; a fresh run will retry')
  return { ...pending, confirmed: status === 'confirmed' }
}

type Watch = { key: string; runs: number; nextAt: bigint; done: boolean }

/**
 * Runs each market once per entry into EarlyCheck or L2Pending, then again on the NOT_YET schedule; failed runs retry
 * on the same schedule. A market leaving those states is dropped.
 */
export class PanelRunner {
  private readonly seen = new Set<Hex>()
  private readonly watch = new Map<Hex, Watch>()

  constructor(private readonly d: RunnerDeps) {
    for (const id of new SubmissionStore(d.snapshotDir, d.chain.chainId, d.chain.oracle).ids()) this.seen.add(id)
  }

  async tick(): Promise<RunResult[]> {
    const log = this.d.log ?? quiet
    const c = this.d.chain
    for (const s of await c.stateChanges()) this.seen.add(s.id.toLowerCase() as Hex)
    const now = await c.now()
    const out: RunResult[] = []
    const store = new SubmissionStore(this.d.snapshotDir, c.chainId, c.oracle)
    for (const id of this.seen) {
      // Reconcile sent work even after the market leaves the panel state or its deadline passes.
      const submission = store.read(id)
      if (submission?.status === 'pending' || submission?.status === 'broadcasting') {
        try {
          const r = await runOnce(id, this.d)
          if (r) out.push(r)
        } catch (error) { log('error', 'panel submission needs reconciliation', { marketId: id, error: String(error) }) }
        // Only a finalized revert permits a fresh send; retry next poll, not the model NOT_YET backoff.
        if (store.read(id)?.status === 'reverted') this.watch.delete(id)
        continue
      }
      const m = await c.market(id)
      const inEarly = m.state === RState.EarlyCheck && now < m.earlyStartedAt + m.earlyTtlSecs && now < m.tau
      const inL2 = m.state === RState.L2Pending && now < m.l2StartedAt + m.l2DeadlineSecs
      if (!inEarly && !inL2) {
        this.watch.delete(id)
        continue
      }
      // A market that re-enters EarlyCheck later starts over.
      const key = watchKey(m)
      let w = this.watch.get(id)
      if (!w || w.key !== key) {
        w = { key, runs: 0, nextAt: now, done: false }
        this.watch.set(id, w)
      }
      if (w.done || now < w.nextAt) continue
      try {
        const r = await runOnce(id, this.d)
        if (r) out.push(r)
        if (r && (r.confirmed || r.skipped?.startsWith('no gas.json'))) w.done = true
        else w.nextAt = now + (RERUN_FIRST_SECS << BigInt(w.runs))
      } catch (e) {
        log('error', 'panel run failed', { marketId: id, error: String(e) })
        if (e instanceof RunnerConfigError) w.done = true // retrying cannot fix a configuration mismatch
        else w.nextAt = now + (RERUN_FIRST_SECS << BigInt(w.runs))
      }
      w.runs++
    }
    return out
  }

  async run(pollMs: number, signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        await this.tick()
      } catch (e) {
        ;(this.d.log ?? quiet)('error', 'tick failed', { error: String(e) })
      }
      await Bun.sleep(pollMs)
    }
  }
}
