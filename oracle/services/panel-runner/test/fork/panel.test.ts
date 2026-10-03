// Task O33.5 acceptance on a local deploy (the keeper's O31.4 stack: O19.3/O19.4 scripts on anvil; a public testnet
// deploy is not authorized, so the testnet run stays for X04). The runner, models and evidence are harness.ts's. Four
// routes, each checked on the oracle:
//   after T   a clean snapshot: the signed payload is accepted and the market goes to Review (no validated category)
//             a flagged snapshot: accepted with flags = 1, the market goes to Review
//   before T  a clean early check returns the market to None; a flagged one goes to EarlyReview
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { deployStack, resolution, revertTo, snapshot, type Stack } from '../../../keeper/test/fork/stack'
import { RState } from '../../src/runner'
import { ATTESTOR, type Evidence, listPinned, makeRunner, runPanel, startEvidence, toEarlyCheck, toL2Pending } from './harness'

const DEPLOY_MS = 600_000
const SCENARIO_MS = 300_000

let s: Stack
let base: Hex
let ev: Evidence

beforeAll(async () => {
  ev = startEvidence()
  s = await deployStack(20_000 + ((process.pid + 7) % 20_000), { attestor: ATTESTOR })
  base = await snapshot(s)
}, DEPLOY_MS)

afterAll(async () => {
  await s?.stop()
  ev?.stop()
})

beforeEach(async () => {
  await revertTo(s, base)
  base = await snapshot(s)
  ev.injected = false
})

describe('panel runner on a local deploy', () => {
  test('after T, clean: the signed payload is accepted and the market goes to Review', async () => {
    const id = await listPinned(s)
    const r = await makeRunner(s, ev) // before the state change: it reads StateChanged logs from here on
    await toL2Pending(s, id)
    const { run, routedTo, flags } = await runPanel(s, r)
    expect(run.route).toBe('Review')
    expect(run.outcomes.map((o) => o.label)).toEqual(['YES', 'YES', 'YES'])
    expect(run.calibratedBps).toEqual([4900, 4900, 4900]) // the placeholder maps
    expect(flags).toBe(0)
    expect(routedTo).toBe(RState.Review)
    expect((await resolution(s, id)).state).toBe(RState.Review)
    expect(await r.tick()).toEqual([]) // the market left L2Pending: nothing more
  }, SCENARIO_MS)

  test('after T, flagged snapshot: accepted with flags = 1, the market goes to Review', async () => {
    ev.injected = true
    const id = await listPinned(s)
    const r = await makeRunner(s, ev)
    await toL2Pending(s, id)
    const { run, routedTo, flags } = await runPanel(s, r)
    expect(run.scan.findings.map((f) => f.rule)).toContain('HIDDEN_TEXT')
    expect(flags).toBe(1)
    expect(routedTo).toBe(RState.Review)
    expect((await resolution(s, id)).state).toBe(RState.Review)
  }, SCENARIO_MS)

  test('before T, clean early check: the market returns to None', async () => {
    const id = await listPinned(s)
    const r = await makeRunner(s, ev)
    await toEarlyCheck(s, id)
    const { run, routedTo, flags } = await runPanel(s, r)
    expect(run.route).toBe('None')
    expect(flags).toBe(0)
    expect(routedTo).toBe(RState.None)
    expect((await resolution(s, id)).state).toBe(RState.None)
  }, SCENARIO_MS)

  test('before T, flagged early check: the market goes to EarlyReview', async () => {
    ev.injected = true
    const id = await listPinned(s)
    const r = await makeRunner(s, ev)
    await toEarlyCheck(s, id)
    const { run, routedTo, flags } = await runPanel(s, r)
    expect(run.route).toBe('EarlyReview')
    expect(flags).toBe(1)
    expect(routedTo).toBe(RState.EarlyReview)
    expect((await resolution(s, id)).state).toBe(RState.EarlyReview)
  }, SCENARIO_MS)
})
