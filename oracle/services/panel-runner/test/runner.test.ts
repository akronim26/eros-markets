// Task O33.5: the runner's decisions against an in-memory chain: what it sends (payload fields, signature, gas key),
// what it does not (NOT_YET majority, a route without a measured gas limit, a market pinned to another
// configuration), the NOT_YET re-run schedule with fresh snapshots, and the StateChanged trigger with polling.
// The local-deploy acceptance (a real oracle accepting the payload and routing it) is test/fork/panel.test.ts.
import { loadGas, modelIdHash, oracleDomain, type PanelResult, panelResultDigest } from '@eros-oracle/oracle-sdk'
import type { Item, Snapshot } from '@eros-oracle/snapshotter'
import { canonicalBytes, evidenceHash } from '@eros-oracle/snapshotter'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, keccak256, recoverAddress, stringToBytes } from 'viem'
import { calibratorHash, placeholderMaps } from '../src/calibration'
import type { Scan } from '../src/injection'
import type { ModelOutcome } from '../src/models/client'
import { loadPrompts } from '../src/prompts'
import { type AIConfig, GAS_KEY_AUTO, type MarketView, type PanelChain, PanelRunner, preRoute, RERUN_FIRST_SECS, RState, type RunnerDeps, runOnce } from '../src/runner'
import { localSigner } from '../src/signer'

const MODELS = ['groq:openai/gpt-oss-120b@2026-10-03', 'nvidia:moonshotai/kimi-k3@2026-10-03', 'google:gemini-3.8-flash@2026-10-03']
const EXTRA = 'anthropic:claude-x@2026-01-01' // configured but not pinned by the market
const MAPS = placeholderMaps([...MODELS, EXTRA])
const prompts = loadPrompts()
const sports = prompts.find((p) => p.category === 'sports')!
const signer = localSigner('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6')
const ID = keccak256(stringToBytes('market-1'))
const ORACLE = '0x837a41023CF81234f89F956C94D676918b4791c1'
const GATE = keccak256(stringToBytes('gate'))

const AI: AIConfig = {
  modelIdHashes: MODELS.map(modelIdHash),
  promptHash: sports.promptHash,
  calibratorHash: calibratorHash(placeholderMaps(MODELS)),
  categoryId: sports.categoryId,
  highConfBps: 9100,
}

class FakeChain implements PanelChain {
  chainId = 10143
  oracle = ORACLE as Hex
  t = 1_800_010_000n
  ai: AIConfig = { ...AI }
  validated = false
  pending: { id: Hex; to: number }[] = []
  views = new Map<Hex, MarketView>()
  simulated: PanelResult[] = []
  sent: { id: Hex; r: PanelResult; uri: string; sig: Hex; gas: bigint }[] = []
  revert: string | null = null
  async now() {
    return this.t
  }
  async stateChanges() {
    const p = this.pending
    this.pending = []
    return p
  }
  async market(id: Hex) {
    return this.views.get(id)!
  }
  async aiConfig() {
    return this.ai
  }
  async text() {
    return { question: 'Will the home team score more than 2 goals?', rules: 'YES if the final home score is above 2; NO otherwise.' }
  }
  async l1Url() {
    return 'https://api.example-sports.com/v1/events/evt_1'
  }
  async allowList() {
    return ['api.example-sports.com', 'stats.example-data.org']
  }
  async activeTrustSetId() {
    return 3
  }
  async categoryValidated() {
    return this.validated
  }
  async simulate(_id: Hex, r: PanelResult) {
    if (this.revert) throw new Error(this.revert)
    this.simulated.push(r)
    return RState.Review
  }
  async send(id: Hex, r: PanelResult, uri: string, sig: Hex, gas: bigint) {
    this.sent.push({ id, r, uri, sig, gas })
    return `0x${'ab'.repeat(32)}` as Hex
  }
}

const view = (over: Partial<MarketView> = {}): MarketView => ({
  state: RState.L2Pending, attempts: 1, trustSetId: 2, l2StartedAt: 1_800_009_000n, earlyStartedAt: 0n, tau: 1_800_001_800n,
  hasFeed: true, gateHash: GATE, l2DeadlineSecs: 7200n, earlyTtlSecs: 21_600n, ...over,
})

const item = (text: string, allowListed = true): Item => ({
  url: 'https://api.example-sports.com/x', host: 'api.example-sports.com', allowListed, fetchedAt: 1_800_010_000, httpStatus: 200,
  contentType: 'application/json', sha256: '', bytesBase64: Buffer.from(text).toString('base64'), truncated: false,
})
const outcome = (model: string, label: ModelOutcome['label'], confidence = 0.95): ModelOutcome => ({
  model, modelIdHash: modelIdHash(model), label, labelCode: { ABSTAIN: 0, YES: 1, NO: 2, INVALID: 3, NOT_YET: 4 }[label], confidence, cited: [0], rationale: '', attempts: [],
})

let chain: FakeChain
let snapshots: Snapshot[]
let labels: ModelOutcome['label'][]
let flags: number
let asked: { models: readonly string[]; user: string }[]
let deps: RunnerDeps

beforeEach(() => {
  chain = new FakeChain()
  chain.views.set(ID, view())
  snapshots = []
  labels = ['NO', 'NO', 'YES']
  flags = 0
  asked = []
  deps = {
    chain,
    signer,
    prompts,
    models: [EXTRA, ...MODELS],
    maps: MAPS,
    gas: loadGas(),
    takeSnapshot: async (req) => {
      const s: Snapshot = { version: 1, marketId: req.marketId, takenAt: Number(chain.t), allowList: req.allowList, items: [item(`{"run":${snapshots.length}}`)], omitted: [] }
      snapshots.push(s)
      return s
    },
    scan: async (): Promise<Scan> => ({ flags, findings: [], scores: [] }),
    askPanel: async (models, call) => {
      asked.push({ models, user: call.user })
      return models.map((m, i) => outcome(m, labels[i]))
    },
    snapshotDir: mkdtempSync(join(tmpdir(), 'snapshots-')),
  }
})

describe('runOnce', () => {
  test('POST_T: the payload the contract checks, signed by the attestor, sent with the measured limit', async () => {
    const r = (await runOnce(ID, deps))!
    expect(r.route).toBe('Review')
    expect(chain.sent.length).toBe(1)
    const { r: p, uri, sig, gas } = chain.sent[0]
    const ev = evidenceHash(snapshots[0])
    expect(uri).toBe(`eros-snapshot:${ev}`)
    expect(p).toEqual({
      marketId: ID, phase: 2, attempt: 1, labels: [2, 2, 1], calibratedBps: [4900, 4900, 4900], evidenceHash: ev,
      evidenceURIHash: keccak256(stringToBytes(uri)), gateHash: GATE, flags: 0, trustSetId: 2, deadline: chain.t + 3600n,
    })
    expect(gas).toBe(190_000n)
    const digest = panelResultDigest(oracleDomain(10143, ORACLE), p)
    expect(await recoverAddress({ hash: digest, signature: sig })).toBe(signer.address)
    expect(chain.simulated.length).toBe(1) // eth_call first
    // the models are the market's, in its modelIdHashes order (not the configured order), with the pinned prompt
    expect(asked[0].models).toEqual(MODELS)
    expect(asked[0].user).toContain('Question: Will the home team score more than 2 goals?')
    // the snapshot is kept under its hash, as its canonical bytes (ADJ-41)
    expect(Buffer.compare(readFileSync(join(deps.snapshotDir, `${ev}.json`)), Buffer.from(canonicalBytes(snapshots[0])))).toBe(0)
    // and the run's record beside it, for the committee console (O34.1)
    const rec = JSON.parse(readFileSync(join(deps.snapshotDir, `${ev}.panel.json`), 'utf8'))
    expect(rec).toMatchObject({ version: 1, marketId: ID, phase: 2, evidenceHash: ev, evidenceURI: uri, calibratedBps: [4900, 4900, 4900], flags: 0 })
    expect(rec.outcomes.map((o: any) => [o.model, o.label, o.labelCode])).toEqual(MODELS.map((m, i) => [m, ['NO', 'NO', 'YES'][i], [2, 2, 1][i]]))
    expect(typeof rec.outcomes[0].rationale).toBe('string')
    expect(rec.candidate.nEff).toBe(3)
  })

  test('EARLY: the active trust set, phase 1; mixed labels return to None, a flagged snapshot goes to EarlyReview', async () => {
    chain.views.set(ID, view({ state: RState.EarlyCheck, earlyStartedAt: 1_800_000_500n }))
    expect((await runOnce(ID, deps))!.route).toBe('None')
    flags = 1
    expect((await runOnce(ID, deps))!.route).toBe('EarlyReview')
    expect(chain.sent.map((s) => [s.r.phase, s.r.trustSetId, s.r.flags])).toEqual([[1, 3, 0], [1, 3, 1]])
  })

  test('POST_T flagged: sent to Review with the flag set', async () => {
    flags = 1
    labels = ['YES', 'YES', 'YES']
    const r = (await runOnce(ID, deps))!
    expect(r.route).toBe('Review')
    expect(chain.sent[0].r.flags).toBe(1)
  })

  test('two or more NOT_YET after T: not sent (the market would stay)', async () => {
    labels = ['NOT_YET', 'YES', 'NOT_YET']
    const r = (await runOnce(ID, deps))!
    expect(r.route).toBe('NotYet')
    expect(chain.sent).toEqual([])
    expect(chain.simulated).toEqual([])
  })

  test('a result that passes the auto gate (validated category) is sent with its own measured limit; without one, not sent', async () => {
    chain.validated = true
    labels = ['YES', 'YES', 'YES']
    deps.maps = [...MODELS, EXTRA].map((model) => ({ model, breakpoints: [[0, 0], [1, 1]] as [number, number][] }))
    chain.ai = { ...AI, calibratorHash: calibratorHash(deps.maps.slice(1).concat(deps.maps.slice(0, 1)).filter((m) => MODELS.includes(m.model)).sort((a, b) => MODELS.indexOf(a.model) - MODELS.indexOf(b.model))) }
    const r = (await runOnce(ID, deps))!
    expect(r.route).toBe('AutoPropose')
    expect(r.sent).toBeDefined()
    expect(chain.sent.map((x) => x.gas)).toEqual([420_000n]) // gas.json submitPanelResultAutoPropose (ADJ-47)
    const { [GAS_KEY_AUTO]: _, ...calls } = deps.gas.calls
    const r2 = (await runOnce(ID, { ...deps, gas: { ...deps.gas, calls } }))!
    expect(r2.skipped).toBe(`no gas.json limit for ${GAS_KEY_AUTO}`)
    expect(chain.sent).toHaveLength(1)
  })

  test('a market pinned to another model, prompt or calibrator: refused before any snapshot or model call', async () => {
    for (const ai of [
      { ...AI, modelIdHashes: [AI.modelIdHashes[0], AI.modelIdHashes[1], modelIdHash('openai:gpt-z@1')] },
      { ...AI, promptHash: keccak256(stringToBytes('prompt')) },
      { ...AI, calibratorHash: keccak256(stringToBytes('calibrator')) },
    ]) {
      chain.ai = ai
      await expect(runOnce(ID, deps)).rejects.toThrow()
    }
    expect(snapshots).toEqual([])
    expect(asked).toEqual([])
  })

  test('an eth_call revert: nothing sent', async () => {
    chain.revert = 'BadPayload(2)'
    await expect(runOnce(ID, deps)).rejects.toThrow('BadPayload(2)')
    expect(chain.sent).toEqual([])
  })

  test('a market in any other state: no run', async () => {
    for (const state of [RState.None, RState.L1Pending, RState.Review, RState.EarlyReview]) {
      chain.views.set(ID, view({ state }))
      expect(await runOnce(ID, deps)).toBeNull()
    }
    expect(snapshots).toEqual([])
  })
})

describe('preRoute', () => {
  test('early: three identical known labels each at or above highConfBps → EarlyReview', () => {
    expect(preRoute(1, [3, 3, 3], [9100, 9200, 9900], 0, AI, false)).toBe('EarlyReview')
    expect(preRoute(1, [1, 1, 1], [9100, 9099, 9900], 0, AI, false)).toBe('None')
    expect(preRoute(1, [4, 4, 4], [9900, 9900, 9900], 0, AI, false)).toBe('None') // NOT_YET is not known
    expect(preRoute(1, [1, 1, 1], [4900, 4900, 4900], 0, AI, false)).toBe('None') // the placeholder never reaches it
  })

  test('post-T: auto-propose only for a binary unanimous confident unflagged result in a validated category', () => {
    expect(preRoute(2, [1, 1, 1], [9500, 9500, 9500], 0, AI, true)).toBe('AutoPropose')
    expect(preRoute(2, [3, 3, 3], [9500, 9500, 9500], 0, AI, true)).toBe('Review') // INVALID is not auto-proposed
    expect(preRoute(2, [1, 1, 1], [9500, 9500, 9500], 1, AI, true)).toBe('Review')
    expect(preRoute(2, [1, 1, 1], [9500, 9500, 9500], 0, AI, false)).toBe('Review')
    expect(preRoute(2, [4, 4, 1], [0, 0, 0], 0, AI, true)).toBe('NotYet')
    expect(preRoute(2, [4, 1, 2], [0, 0, 0], 0, AI, true)).toBe('Review') // one NOT_YET is not a majority
  })
})

describe('PanelRunner', () => {
  test('triggered by StateChanged; a sent result is not sent again while the market stays', async () => {
    const runner = new PanelRunner(deps)
    expect(await runner.tick()).toEqual([]) // nothing seen yet
    chain.pending.push({ id: ID, to: RState.L2Pending })
    expect((await runner.tick()).length).toBe(1)
    chain.t += 3600n
    expect(await runner.tick()).toEqual([])
    expect(chain.sent.length).toBe(1)
  })

  test('NOT_YET: re-runs after 15 min, 30 min, 1 h, 2 h, … with a fresh snapshot each time, until the L2 deadline', async () => {
    labels = ['NOT_YET', 'NOT_YET', 'YES']
    chain.views.set(ID, view({ l2StartedAt: chain.t, l2DeadlineSecs: 4n * 3600n }))
    const start = chain.t
    const runner = new PanelRunner(deps)
    chain.pending.push({ id: ID, to: RState.L2Pending })
    const runsAt: bigint[] = []
    for (let s = 0n; s <= 5n * 3600n; s += 60n) {
      chain.t = start + s
      if ((await runner.tick()).length) runsAt.push(s)
    }
    const min = (m: bigint) => m * 60n
    expect(runsAt).toEqual([0n, min(15n), min(15n + 30n), min(15n + 30n + 60n), min(15n + 30n + 60n + 120n)].filter((x) => x < 4n * 3600n))
    expect(RERUN_FIRST_SECS).toBe(900n)
    expect(snapshots.length).toBe(runsAt.length)
    expect(new Set(snapshots.map((s) => evidenceHash(s))).size).toBe(snapshots.length) // each a fresh snapshot
    expect(chain.sent).toEqual([])
  })

  test('polling: a market seen once is re-read every tick, and a run that failed is retried on the schedule', async () => {
    const runner = new PanelRunner(deps)
    chain.views.set(ID, view({ state: RState.L1Pending }))
    chain.pending.push({ id: ID, to: RState.L1Pending }) // seen, but not yet for the panel
    expect(await runner.tick()).toEqual([])
    chain.views.set(ID, view()) // its L2Pending log was missed
    chain.revert = 'temporarily failing'
    expect(await runner.tick()).toEqual([])
    chain.revert = null
    chain.t += RERUN_FIRST_SECS - 1n
    expect(await runner.tick()).toEqual([])
    chain.t += 1n
    expect((await runner.tick()).length).toBe(1)
    expect(chain.sent.length).toBe(1)
  })

  test('a market pinned to another configuration is not retried', async () => {
    chain.ai = { ...AI, promptHash: keccak256(stringToBytes('prompt')) }
    const runner = new PanelRunner(deps)
    chain.pending.push({ id: ID, to: RState.L2Pending })
    await runner.tick()
    chain.t += 10n * 3600n
    chain.views.set(ID, view({ l2DeadlineSecs: 20n * 3600n }))
    await runner.tick()
    expect(snapshots).toEqual([])
  })

  test('EarlyCheck past its TTL or at T, and L2Pending past its deadline, are not run', async () => {
    const runner = new PanelRunner(deps)
    chain.pending.push({ id: ID, to: RState.EarlyCheck })
    chain.views.set(ID, view({ state: RState.EarlyCheck, earlyStartedAt: chain.t - 21_600n }))
    expect(await runner.tick()).toEqual([])
    chain.views.set(ID, view({ state: RState.EarlyCheck, earlyStartedAt: chain.t, tau: chain.t }))
    expect(await runner.tick()).toEqual([])
    chain.views.set(ID, view({ l2StartedAt: chain.t - 7200n }))
    expect(await runner.tick()).toEqual([])
    expect(snapshots).toEqual([])
  })
})
