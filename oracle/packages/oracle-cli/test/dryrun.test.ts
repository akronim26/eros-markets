// Task O22.3, steps 1 and 3: the burst test and the three dry-run simulations write dryrun.log and fail loudly.
// The simulator double evaluates the config it is given against fixture responses with the evaluator, so the
// configs oracle-cli writes (feed, allow-list, authRef table) are exercised; the real `cre` run is recorded in
// the task notes. The parser is checked on the output of a real `cre workflow simulate dryrun` run.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateResponse, type FeedSpec } from '@eros-oracle/feedspec'
import { keccak256, toBytes } from 'viem'
import { dryRun, type Simulate, simulationResult } from '../src/dryrun'
import { list, ListError } from '../src/list'

const FIX = new URL('./fixtures/', import.meta.url).pathname
const sample = JSON.parse(readFileSync(join(FIX, 'sample-listing.json'), 'utf8'))
const BODIES: Record<string, string> = {
  evt_finished_1: readFileSync(join(FIX, 'reference-final.json'), 'utf8'),
  evt_live_1: readFileSync(join(FIX, 'reference-live.json'), 'utf8'),
}
const ZERO32 = `0x${'00'.repeat(32)}`
const FORGE = 120_000

/** A pack for the sample (or a variant) in a fresh output dir; returns the input path and the dir. */
async function packFor(edit: (l: any) => void = () => {}) {
  const l = structuredClone(sample)
  l.dryRun = { liveUrlParam: 'evt_live_1' }
  edit(l)
  const out = mkdtempSync(join(tmpdir(), 'oracle-cli-'))
  const input = join(out, 'listing.json')
  writeFileSync(input, JSON.stringify(l))
  const r = await list({ input, out, referenceFile: join(FIX, 'reference-final.json'), oracle: '0x' + 'aa'.repeat(20), check: false })
  return { input, out, dir: r.dir }
}

/** The workflow's behaviour on a config: evaluate the fixture response of its urlParam. */
const configs: any[] = []
const simulator: Simulate = async (path) => {
  const cfg = JSON.parse(readFileSync(path, 'utf8'))
  configs.push(cfg)
  const spec = cfg.feed as FeedSpec
  const body = BODIES[spec.urlParam]
  if (body === undefined) return `ERROR|${ZERO32}|HTTP_404`
  const ev = evaluateResponse(spec, 200, body.trim(), Buffer.byteLength(body))
  const vh = ev.status === 'YES' || ev.status === 'NO' ? keccak256(toBytes(ev.valueLexeme)) : ZERO32
  return `${ev.status}|${vh}|${ev.code}`
}
const ok200 = (async () => new Response('{}')) as unknown as typeof fetch

describe('dryrun', () => {
  test('writes dryrun.log with the burst and the three runs, all PASS', async () => {
    const { input, out, dir } = await packFor()
    const urls: string[] = []
    const fetchImpl = (async (url: string) => { urls.push(url); return new Response('{}') }) as unknown as typeof fetch
    configs.length = 0
    const r = await dryRun({ input, out, nodes: 7, fetchImpl, simulate: simulator, now: () => new Date('2026-10-03T00:00:00Z') })
    expect(r.pass).toBe(true)
    expect(urls).toEqual(Array(7).fill('https://api.example-sports.com/v1/events/evt_finished_1'))
    const log = readFileSync(join(dir, 'dryrun.log'), 'utf8')
    expect(log).toBe(r.log)
    const lines = log.trim().split('\n')
    expect(lines[0]).toBe(`# dryrun.log: oracle-cli dryrun (O22.3), market ${keccak256(toBytes(sample.slug))}, 2026-10-03T00:00:00.000Z`)
    expect(lines.slice(2)).toEqual([
      'PASS burst: 7 parallel GET https://api.example-sports.com/v1/events/evt_finished_1; expected 7x 200; got 7x 200',
      `PASS sim finished: urlParam evt_finished_1; expected YES|${keccak256(toBytes('3'))}|OK; got YES|${keccak256(toBytes('3'))}|OK`,
      `PASS sim live: urlParam evt_live_1; expected NOT_READY|${ZERO32}|*; got NOT_READY|${ZERO32}|NOT_FINAL`,
      `PASS sim wrong-path: urlParam evt_finished_1, valuePath event.home.__oracle_cli_missing__; expected ERROR|${ZERO32}|*; got ERROR|${ZERO32}|VALUE_MISSING`,
      'result: PASS',
    ])
    // the configs are the dry-run workflow's: the market's feed and allow-list, the resolution authRef table
    const staging = JSON.parse(readFileSync(new URL('../../../workflows/resolution/config.staging.json', import.meta.url), 'utf8'))
    for (const c of configs) {
      expect(Object.keys(c).sort()).toEqual(['allowList', 'authSecrets', 'feed', 'httpTimeout', 'schedule'])
      expect(c.allowList).toEqual(sample.marketInput.allowList)
      expect(c.authSecrets).toEqual(staging.authSecrets)
    }
    expect(configs[0].feed).toEqual({ ...sample.marketInput.feed, urlParam: 'evt_finished_1' })
  }, FORGE)

  test('a 429 in the burst, a wrong finished result or a failed simulation fails, and the log says why', async () => {
    const { input, out, dir } = await packFor()
    let n = 0
    const one429 = (async () => new Response('{}', { status: n++ === 3 ? 429 : 200 })) as unknown as typeof fetch
    const burst = await dryRun({ input, out, nodes: 5, fetchImpl: one429, simulate: simulator })
    expect(burst.pass).toBe(false)
    expect(burst.burst.got).toBe('4x 200, 1x 429')
    expect(readFileSync(join(dir, 'dryrun.log'), 'utf8')).toContain('FAIL burst: 5 parallel GET')
    expect(burst.log.trim().endsWith('result: FAIL')).toBe(true)

    const flips: Simulate = async (p) => (p.endsWith('config.finished.json') ? `NO|${keccak256(toBytes('3'))}|OK` : simulator(p))
    const wrong = await dryRun({ input, out, nodes: 1, fetchImpl: ok200, simulate: flips })
    expect(wrong.pass).toBe(false)
    expect(wrong.runs.map((x) => x.pass)).toEqual([false, true, true])

    // the right status with another value hash is a mismatch: the run must reproduce reference.json exactly
    const otherValue: Simulate = async (p) => (p.endsWith('config.finished.json') ? `YES|${keccak256(toBytes('4'))}|OK` : simulator(p))
    expect((await dryRun({ input, out, nodes: 1, fetchImpl: ok200, simulate: otherValue })).runs[0].pass).toBe(false)
    // an ERROR where NOT_READY is expected (e.g. the live event's URL is wrong) is a mismatch
    const liveError: Simulate = async (p) => (p.endsWith('config.live.json') ? `ERROR|${ZERO32}|HTTP_404` : simulator(p))
    expect((await dryRun({ input, out, nodes: 1, fetchImpl: ok200, simulate: liveError })).runs.map((x) => x.pass)).toEqual([true, false, true])

    const broken: Simulate = async () => { throw new Error('cre exited 1: not logged in') }
    const failed = await dryRun({ input, out, nodes: 1, fetchImpl: ok200, simulate: broken })
    expect(failed.pass).toBe(false)
    expect(failed.runs[0].got).toBe('SIMULATION_FAILED: cre exited 1: not logged in')
  }, FORGE)

  test('a "live" event that is already final fails the NOT_READY run', async () => {
    const { input, out } = await packFor((l) => (l.dryRun.liveUrlParam = 'evt_finished_1'))
    const r = await dryRun({ input, out, nodes: 1, fetchImpl: ok200, simulate: simulator })
    expect(r.runs.map((x) => `${x.name}:${x.pass}`)).toEqual(['sim finished:true', 'sim live:false', 'sim wrong-path:true'])
  }, FORGE)

  test('the burst sends the authRef header, from the workflow config and the environment', async () => {
    const authRef = keccak256(toBytes('SPORTSDATA_V1'))
    const { input, out } = await packFor((l) => (l.marketInput.feed.authRef = authRef))
    const seen: Record<string, string>[] = []
    const fetchImpl = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response('{}') }) as unknown as typeof fetch
    await dryRun({ input, out, nodes: 2, fetchImpl, simulate: simulator, env: { SPORTSDATA_API_KEY_VALUE: 'k-1' } })
    expect(seen).toEqual([{ accept: 'application/json', 'x-api-key': 'k-1' }, { accept: 'application/json', 'x-api-key': 'k-1' }])
    await expect(dryRun({ input, out, nodes: 2, fetchImpl, simulate: simulator, env: {} })).rejects.toThrow(/set SPORTSDATA_API_KEY_VALUE/)
  }, FORGE)

  test('refuses without a live event, a DON size or a pack', async () => {
    const { input, out } = await packFor((l) => delete l.dryRun)
    await expect(dryRun({ input, out, nodes: 1, simulate: simulator })).rejects.toThrow(/no dryRun.liveUrlParam/)
    const p = await packFor()
    await expect(dryRun({ input: p.input, out: p.out, nodes: 0, simulate: simulator })).rejects.toThrow(/--nodes/)
    await expect(dryRun({ input: p.input, out: mkdtempSync(join(tmpdir(), 'x-')), nodes: 1, simulate: simulator })).rejects.toBeInstanceOf(ListError)
  }, FORGE)
})

describe('simulationResult', () => {
  test('reads the result of a real `cre workflow simulate dryrun` run (CRE CLI v1.36.0)', () => {
    const out = readFileSync(join(FIX, 'cre-simulate-output.txt'), 'utf8')
    expect(simulationResult(out, 0)).toBe(`ERROR|${ZERO32}|FETCH_FAILED`)
  })

  test('a non-zero exit or a missing result throws', () => {
    const out = readFileSync(join(FIX, 'cre-simulate-output.txt'), 'utf8')
    expect(() => simulationResult(out, 1)).toThrow(/cre exited 1/)
    expect(() => simulationResult('✗ Workflow compile failed', 0)).toThrow(/no simulation result/)
  })
})
