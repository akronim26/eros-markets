import { expect, test } from 'bun:test'
import { loadGas } from '@eros-oracle/oracle-sdk'
import { actOnContradiction } from '../src/dispute'
import { assertLiveness, disputeMargin } from '../src/timing'
import { askWatchdogModel } from '../src/model'
import { Watchdog } from '../src/watchdog'
import { FakeChain, l1Proposal } from './fake'
import type { Hex } from 'viem'
import type { Verdict } from '../src/types'

const testnet = { network: 'monad-testnet', deploymentChainId: 10143, rpcChainId: 10143 }
const windows = { livenessL1: 120n, livenessAuto: 120n, livenessReviewed: 300n }
test('600 seconds remains the default; only an explicit actual testnet override accepts 30–599 seconds', () => {
  expect(disputeMargin(testnet)).toBe(600n)
  expect(disputeMargin({ network: 'monad-mainnet', deploymentChainId: 143, rpcChainId: 143 })).toBe(600n)
  expect(disputeMargin({ ...testnet, testnetMargin: '30' })).toBe(30n)
  for (const testnetMargin of ['0', '29', '600', '-1', '1.5']) expect(() => disputeMargin({ ...testnet, testnetMargin })).toThrow()
  for (const patch of [{ network: 'monad-mainnet' }, { rpcChainId: 143 }, { deploymentChainId: 143 }, { deploymentChainId: 143, rpcChainId: 143 }]) {
    expect(() => disputeMargin({ ...testnet, ...patch, testnetMargin: '30' })).toThrow()
  }
  expect(() => assertLiveness(windows, 600n)).toThrow('livenessL1=120s')
  expect(() => assertLiveness(windows, 30n)).not.toThrow()
  for (const field of Object.keys(windows)) expect(() => assertLiveness({ ...windows, [field]: 30n }, 30n)).toThrow()
})

test('short-window disputes send before the margin, page at the boundary and recheck after simulation', async () => {
  const contradiction: Verdict = { kind: 'CONTRADICT', signals: [], reason: 'contradiction' }
  for (const [elapsed, simulatedDelay, expected] of [[89n, 0n, 'DISPUTED'], [90n, 0n, 'PAGED'], [89n, 1n, 'PAGED']] as const) {
    const chain = new FakeChain()
    chain.windows = windows
    const proposal = l1Proposal(1)
    chain.propose(proposal, `0x${'a1'.repeat(32)}` as Hex, { expiresAt: chain.t + 120n })
    chain.t += elapsed
    chain.simulateDispute = async () => { chain.t += simulatedDelay }
    const result = await actOnContradiction(proposal, contradiction, chain, loadGas(), () => {}, 30n)
    expect(result.action).toBe(expected)
    expect(chain.disputed.length).toBe(expected === 'DISPUTED' ? 1 : 0)
  }
})

test('short-margin model mode avoids the default retry chain', async () => {
  let calls = 0
  const result = await askWatchdogModel('google:gemini-3.8-flash@2026-10-03', { system: 'test', user: 'test' }, {
    env: { GEMINI_API_KEY: 'fixture' }, maxRetries: 0, timeoutMs: 20_000,
    fetchFn: (async () => { calls++; return new Response('{}', { status: 503 }) }) as unknown as typeof fetch,
    sleep: async () => { throw new Error('must not retry') },
  })
  expect(calls).toBe(1)
  expect(result.error).toBe('HTTP 503')
})

test('runtime discovery pages incompatible immutable windows before any source or model call', async () => {
  const chain = new FakeChain()
  chain.windows = windows
  chain.queue.proposals.push(l1Proposal(1))
  const pages: string[] = []
  const watchdog = new Watchdog({ chain, gas: loadGas(), page: event => { pages.push(event.kind) },
    model: { loadSnapshot: async () => { throw new Error('must not check an incompatible listing') } },
    l1: { fetchFn: (async () => { throw new Error('must not fetch an incompatible listing') }) as unknown as typeof fetch } })
  expect((await watchdog.tick()).checked).toEqual([])
  expect(pages).toEqual(['LIVENESS_INCOMPATIBLE'])
  expect(chain.disputed).toEqual([])
})
