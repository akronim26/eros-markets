// Real keepers against a local deploy of the oracle, UMA's OOv3 and the stub engine. The test moves the clock and
// plays the CRE relayer, a disputer and the DVM. No keeper transaction may revert. Each scenario starts from the
// same snapshot with fresh keeper keys.
import { loadGas, MarketRegistryAbi } from '@eros-oracle/oracle-sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type Address, createPublicClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { viemChain } from '../../src/chain'
import { globalPlanners, planners, RState } from '../../src/jobs'
import { Keeper } from '../../src/keeper'
import { RegistryLogSource, TreasuryDisputeSource } from '../../src/sources'
import type { JobResult, Logger } from '../../src/types'
import {
  deployStack,
  dispute,
  dvmAnswer,
  fund,
  listExample,
  now,
  reportL1,
  resolution,
  revertTo,
  snapshot,
  type Stack,
  venueStatus,
  warpTo,
} from './stack'

const DEPLOY_MS = 600_000
const SCENARIO_MS = 300_000 // listing through forge script takes seconds
const YES = 1
const NO = 2
const INVALID = 3
const ASSERTED_TRUE = 1
const VOID_DEADLINE = 3

type Instance = {
  keeper: Keeper
  address: Address
  sent: { hash: Hex; action: string; gasKey: string; status?: 'success' | 'reverted' }[]
  alerts: string[]
}

let s: Stack
let base: Hex

/** Wired as main.ts does, with a fresh funded key. */
async function instance(delayMs = 0): Promise<Instance> {
  const key = generatePrivateKey()
  const address = privateKeyToAccount(key).address
  await fund(s, address)
  const chain = viemChain({ rpcUrl: s.rpcUrl, privateKey: key, deployments: s.deployments })
  const sent: Instance['sent'] = []
  const send = chain.send.bind(chain)
  chain.send = async (job, gas) => {
    const hash = await send(job, gas)
    sent.push({ hash, action: job.action, gasKey: job.gasKey })
    return hash
  }
  const logs = createPublicClient({ chain: foundry, transport: http(s.rpcUrl) })
  const { MarketRegistry: reg, BondTreasury: tr } = s.deployments.contracts
  const alerts: string[] = []
  const log: Logger = { info: () => {}, warn: () => {}, error: (msg) => void alerts.push(msg) }
  const keeper = new Keeper({
    chain,
    source: new RegistryLogSource(logs, reg.address as Address, BigInt(reg.deployBlock)),
    planners: planners({ realEngine: false }), // anvil carries StubMarketFactory, as testnet does
    globalPlanners: globalPlanners(new TreasuryDisputeSource(logs, tr.address as Address, BigInt(tr.deployBlock))),
    gas: loadGas(),
    delayMs,
    log,
  })
  return { keeper, address, sent, alerts }
}

/** Ticks every instance concurrently and returns the actions sent, once their transactions land. */
async function tick(...xs: Instance[]): Promise<string[]> {
  const before = xs.map((x) => x.sent.length)
  const reports = await Promise.all(xs.map((x) => x.keeper.tick()))
  for (const r of reports) expect(r.results.filter((j: JobResult) => j.outcome === 'failed')).toEqual([])
  const actions: string[] = []
  for (const [i, x] of xs.entries()) {
    for (const t of x.sent.slice(before[i])) {
      t.status = (await s.pc.waitForTransactionReceipt({ hash: t.hash })).status
      expect({ action: t.action, status: t.status }).toEqual({ action: t.action, status: 'success' }) // never a reverting transaction
      actions.push(t.action)
    }
  }
  return actions
}

const noReverts = (...xs: Instance[]) => expect(xs.flatMap((x) => x.sent.filter((t) => t.status !== 'success'))).toEqual([])

async function core(id: Hex) {
  const registry = s.deployments.contracts.MarketRegistry.address as Address
  const c = await s.pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [id] })
  const f = await s.pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'getFeedSpec', args: [id] })
  return { tau: c.tau, buffer: BigInt(f.bufferSecs), l1Timeout: BigInt(f.l1TimeoutSecs), l2Deadline: BigInt(c.l2DeadlineSecs) }
}

async function toAsserted(k: Instance, outcome: 1 | 2 = YES): Promise<Hex> {
  const id = await listExample(s)
  const c = await core(id)
  expect(await tick(k)).toEqual([]) // before T: nothing is due
  await warpTo(s, c.tau)
  expect(await tick(k)).toEqual(['halt'])
  expect((await resolution(s, id)).state).toBe(RState.L1Pending)
  expect(await tick(k)).toEqual([]) // within the buffer
  await warpTo(s, c.tau + c.buffer)
  expect(await tick(k)).toEqual(['request'])
  expect((await resolution(s, id)).requestCount).toBe(1)
  await reportL1(s, id, outcome, await now(s))
  expect(await tick(k)).toEqual(['assert'])
  const r = await resolution(s, id)
  expect(r.state).toBe(RState.Proposed)
  expect(r.attempts).toBe(1)
  expect(r.assertionId).not.toBe(`0x${'00'.repeat(32)}`)
  return id
}

beforeAll(async () => {
  s = await deployStack(20_000 + (process.pid % 20_000))
  base = await snapshot(s)
}, DEPLOY_MS)

afterAll(async () => {
  await s?.stop()
})

beforeEach(async () => {
  await revertTo(s, base)
  base = await snapshot(s) // a snapshot is used up by its revert
})

describe('keeper on a local deploy', () => {
  test('L1 path: halt, request, assert, finalize → Final YES (ASSERTED_TRUE)', async () => {
    const k = await instance()
    const id = await toAsserted(k)
    expect(await tick(k)).toEqual([]) // liveness running
    await warpTo(s, (await venueStatus(s, id)).expiresAt)
    expect(await tick(k)).toEqual(['finalize'])
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Final)
    expect(r.outcome).toBe(YES)
    expect(r.finalReason).toBe(ASSERTED_TRUE)
    expect(await tick(k)).toEqual([]) // the stub engine enables claims at once; nothing left to do
    noReverts(k)
    expect(k.alerts).toEqual([])
  }, SCENARIO_MS)

  test('rejection: dispute, sync, DVM says false, finalize → Review; open at retryOpensAt', async () => {
    const k = await instance()
    const id = await toAsserted(k)
    await dispute(s, id)
    expect(await tick(k)).toEqual(['sync'])
    expect((await resolution(s, id)).state).toBe(RState.Disputed)
    expect(await tick(k)).toEqual([]) // the DVM has not answered: finalize would return DISPUTED again
    await dvmAnswer(s, false)
    expect(await tick(k)).toEqual(['finalize'])
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Review)
    expect(r.rejectedMask).toBe(1 << YES)
    expect(r.assertionId).toBe(`0x${'00'.repeat(32)}`)
    expect(r.retryOpensAt).toBeGreaterThan(0n)
    expect(await tick(k)).toEqual([]) // committee-only until retryOpensAt
    await warpTo(s, r.retryOpensAt)
    expect(await tick(k)).toEqual(['open'])
    expect((await resolution(s, id)).state).toBe(RState.Open)
    noReverts(k)
  }, SCENARIO_MS)

  test('no answer: request, escalate, open, then void at the deadline → Final INVALID (VOID_DEADLINE)', async () => {
    const k = await instance()
    const id = await listExample(s)
    const c = await core(id)
    await warpTo(s, c.tau)
    expect(await tick(k)).toEqual(['halt'])
    await warpTo(s, c.tau + c.buffer)
    expect(await tick(k)).toEqual(['request']) // the CRE never answers
    await warpTo(s, c.tau + c.l1Timeout)
    expect(await tick(k)).toEqual(['escalate'])
    const r1 = await resolution(s, id)
    expect(r1.state).toBe(RState.L2Pending)
    await warpTo(s, r1.l2StartedAt + c.l2Deadline)
    expect(await tick(k)).toEqual(['open']) // no panel, no committee, no permissionless proposer
    expect((await resolution(s, id)).state).toBe(RState.Open)
    expect(await tick(k)).toEqual([])
    await warpTo(s, r1.voidDeadline - 1n)
    expect(await tick(k)).toEqual([]) // one second early
    await warpTo(s, r1.voidDeadline)
    expect(await tick(k)).toEqual(['void'])
    expect(k.sent.at(-1)!.gasKey).toBe('voidMarket')
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Final)
    expect(r.outcome).toBe(INVALID)
    expect(r.finalReason).toBe(VOID_DEADLINE)
    expect(await tick(k)).toEqual([])
    noReverts(k)
  }, SCENARIO_MS)

  test('void at the deadline with a disputed assertion the DVM never answers → Final INVALID, bond stuck', async () => {
    const k = await instance()
    const id = await toAsserted(k, NO)
    await dispute(s, id)
    expect(await tick(k)).toEqual(['sync'])
    const r1 = await resolution(s, id)
    await warpTo(s, r1.voidDeadline)
    expect(await tick(k)).toEqual(['void'])
    expect(k.sent.at(-1)!.gasKey).toBe('voidMarketStuck')
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Final)
    expect(r.outcome).toBe(INVALID)
    expect(r.finalReason).toBe(VOID_DEADLINE)
    noReverts(k)
  }, SCENARIO_MS)

  test('two instances, the second offset (production): each job is sent once, the other sees it stale', async () => {
    const a = await instance()
    const b = await instance(250)
    const id = await listExample(s)
    const c = await core(id)
    await warpTo(s, c.tau)
    expect(await tick(a, b)).toEqual(['halt'])
    await warpTo(s, c.tau + c.buffer)
    expect(await tick(a, b)).toEqual(['request'])
    await reportL1(s, id, YES, await now(s))
    expect(await tick(a, b)).toEqual(['assert'])
    await warpTo(s, (await venueStatus(s, id)).expiresAt)
    expect(await tick(a, b)).toEqual(['finalize'])
    expect(b.sent).toEqual([]) // the offset instance only ever found its jobs done
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Final)
    expect(r.outcome).toBe(YES)
    expect(r.attempts).toBe(1)
    expect(r.requestCount).toBe(1)
    noReverts(a, b)
  }, SCENARIO_MS)

  test('two instances with no offset: duplicates may both land, as no-ops, never reverts', async () => {
    const a = await instance()
    const b = await instance()
    const id = await listExample(s)
    const c = await core(id)
    const once = (actions: string[], action: string) => {
      expect(actions.length).toBeGreaterThanOrEqual(1)
      expect(actions.length).toBeLessThanOrEqual(2)
      expect(new Set(actions)).toEqual(new Set([action]))
    }
    await warpTo(s, c.tau)
    once(await tick(a, b), 'halt')
    await warpTo(s, c.tau + c.buffer)
    once(await tick(a, b), 'request')
    await reportL1(s, id, YES, await now(s))
    once(await tick(a, b), 'assert')
    await warpTo(s, (await venueStatus(s, id)).expiresAt)
    once(await tick(a, b), 'finalize')
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Final)
    expect(r.outcome).toBe(YES)
    expect(r.attempts).toBe(1) // one treasury bond, however many assertProposal calls landed
    expect(r.requestCount).toBe(1) // one CRE trigger
    expect(await tick(a, b)).toEqual([])
    noReverts(a, b)
  }, SCENARIO_MS)
})
