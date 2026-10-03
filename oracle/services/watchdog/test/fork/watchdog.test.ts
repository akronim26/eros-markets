// The real watchdog against a local deploy, with a canned feed. Liveness is 30 min (L1) and 1 h (reviewed) because the
// watchdog does not dispute in the last 10 minutes before expiry.
import { loadGas, MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type Address, createWalletClient, type Hex, http, parseEventLogs } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { deployStack, fund, listExample, now, reportL1, resolution, revertTo, snapshot, type Stack, venueStatus, warpTo } from '../../../keeper/test/fork/stack'
import { viemWatchdogChain } from '../../src/chain'
import { DISPUTE_MARGIN_SECS } from '../../src/dispute'
import type { Page } from '../../src/types'
import { Watchdog } from '../../src/watchdog'
import { event } from '../fake'

const DEPLOY_MS = 600_000
const SCENARIO_MS = 300_000
const WATCHDOG_KEY = generatePrivateKey()
const WATCHDOG = privateKeyToAccount(WATCHDOG_KEY).address
const LIVENESS_L1 = 1800n
const LIVENESS_REVIEWED = 3600n
const HEARTBEAT_MAX_AGE = 900n // params.monad-testnet.json globals

let s: Stack
let base: Hex
let home = 1

const feedFetch = (async () => new Response(event(home, 1))) as unknown as typeof fetch
const oracle = () => s.deployments.contracts.ResolutionOracle.address as Address

beforeAll(async () => {
  s = await deployStack(20_000 + ((process.pid + 19) % 20_000), { watchdog: WATCHDOG })
  await fund(s, WATCHDOG)
  base = await snapshot(s)
}, DEPLOY_MS)

afterAll(async () => {
  await s?.stop()
})

beforeEach(async () => {
  await revertTo(s, base)
  base = await snapshot(s)
})

/** voidSecs raised to the registry's bound for the longer liveness. */
const list = () =>
  listExample(s, (pack) => {
    pack.marketInput.uma.livenessL1 = Number(LIVENESS_L1)
    pack.marketInput.uma.livenessAuto = Number(LIVENESS_L1)
    pack.marketInput.uma.livenessReviewed = Number(LIVENESS_REVIEWED)
    pack.marketInput.voidSecs = 6 * 3600 // ≥ 300 + 600 + 3·(3600 + 2·300) + 2·(600 + 300) + 600 = 15,900
  })

function watchdog(pages: Parameters<Page>[0][]) {
  const chain = viemWatchdogChain({ rpcUrl: s.rpcUrl, watchdogKey: WATCHDOG_KEY, deployments: s.deployments, fromBlock: 0n })
  const w = new Watchdog({ chain, gas: loadGas(), page: (e) => void pages.push(e), l1: { fetchFn: feedFetch }, model: { loadSnapshot: async () => null } })
  return { w, chain }
}

async function anyone(functionName: string, args: unknown[]) {
  const k = generatePrivateKey()
  await fund(s, privateKeyToAccount(k).address)
  const w = createWalletClient({ chain: foundry, transport: http(s.rpcUrl), account: privateKeyToAccount(k) })
  const r = await s.pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: oracle(), abi: ResolutionOracleAbi, functionName, args } as never) })
  expect(r.status).toBe('success')
  return r
}

async function haltAndReport(id: Hex, outcome: 1 | 2) {
  const r0 = await s.pc.readContract({ address: s.deployments.contracts.MarketRegistry.address as Address, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [id] })
  await warpTo(s, r0.tau)
  await anyone('haltScheduled', [id])
  await warpTo(s, r0.tau + 60n)
  await reportL1(s, id, outcome, r0.tau + 60n)
}

const livenessFor = (id: Hex) => s.pc.readContract({ address: oracle(), abi: ResolutionOracleAbi, functionName: 'livenessFor', args: [id] })

describe('watchdog on a local deploy', () => {
  test('a wrong Layer 1 proposal is disputed with the float inside liveness', async () => {
    home = 1 // the feed says NO
    const id = await list()
    const pages: Parameters<Page>[0][] = []
    const { w, chain } = watchdog(pages)
    await haltAndReport(id, 1) // the report says YES

    let t = await w.tick()
    expect(t.heartbeat).not.toBeNull()
    expect(t.checked).toHaveLength(1)
    expect(t.checked[0].verdict.kind).toBe('CONTRADICT')
    expect(t.checked[0].result).toEqual({ action: 'WAIT', reason: 'not asserted yet' })

    const asserted = await anyone('assertProposal', [id])
    const [a] = parseEventLogs({ abi: ResolutionOracleAbi, eventName: 'Asserted', logs: asserted.logs })
    expect(a.args.liveness).toBe(LIVENESS_L1) // the heartbeat is fresh
    const floatBefore = await chain.floatBalance()

    t = await w.tick()
    expect(t.checked[0].result!.action).toBe('DISPUTED')
    const hash = (t.checked[0].result as { hash: Hex }).hash
    const receipt = await s.pc.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')
    expect(receipt.gasUsed).toBeLessThanOrEqual(BigInt(loadGas().calls.disputeViaVenue.limit))
    const block = await s.pc.getBlock({ blockNumber: receipt.blockNumber })
    expect(block.timestamp).toBeLessThan(a.args.expiresAt! - DISPUTE_MARGIN_SECS) // inside liveness, before the margin
    const st = await venueStatus(s, id)
    expect(st.disputed).toBe(true)
    expect(st.disputer).toBe(s.deployments.contracts.BondTreasury.address)
    expect(await chain.floatBalance()).toBe(floatBefore - st.bond)
    expect(pages.map((p) => p.kind)).toEqual(['DISPUTED'])
    await anyone('syncAssertion', [id])
    expect((await resolution(s, id)).state).toBe(8) // Disputed
  }, SCENARIO_MS)

  test('a stopped heartbeat moves L1 liveness to the reviewed value', async () => {
    home = 3 // the feed agrees with YES
    const id = await list()
    const pages: Parameters<Page>[0][] = []
    const { w, chain } = watchdog(pages)
    await haltAndReport(id, 1)
    expect(await livenessFor(id)).toBe(LIVENESS_REVIEWED) // no heartbeat yet
    const t = await w.tick()
    await s.pc.waitForTransactionReceipt({ hash: t.heartbeat! })
    expect(t.checked[0].verdict.kind).toBe('AGREE')
    expect(await livenessFor(id)).toBe(LIVENESS_L1)

    // the watchdog stops: once its heartbeat is older than heartbeatMaxAgeSecs, L1 liveness is the reviewed one
    const last = await chain.lastHeartbeat()
    await warpTo(s, last + HEARTBEAT_MAX_AGE)
    expect(await livenessFor(id)).toBe(LIVENESS_L1) // exactly at the max age: still fresh
    await warpTo(s, last + HEARTBEAT_MAX_AGE + 1n)
    expect(await livenessFor(id)).toBe(LIVENESS_REVIEWED)
    const asserted = await anyone('assertProposal', [id])
    const [a] = parseEventLogs({ abi: ResolutionOracleAbi, eventName: 'Asserted', logs: asserted.logs })
    expect(a.args.liveness).toBe(LIVENESS_REVIEWED)
    expect(a.args.expiresAt).toBe((await now(s)) + LIVENESS_REVIEWED)
    expect(pages).toEqual([])
  }, SCENARIO_MS)
})
