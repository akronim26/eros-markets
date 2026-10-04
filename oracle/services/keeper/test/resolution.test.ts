import { describe, expect, test } from 'bun:test'
import { gasLimit } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { FINALIZE_BATCH, finalizeManyGas, FinalizeStatus, resolutionPlanner, RState } from '../src/jobs/resolution'
import { Keeper } from '../src/keeper'
import { StaticSource } from '../src/sources'
import type { AssertionStatus, Job, MarketInfo, MarketView, Resolution } from '../src/types'
import { stateVersion } from '../src/version'
import { BOOK_IDENTITY, FakeChain, GAS, id, INFO, resolution, STUB_IDENTITY, withoutGasLimits } from './fake'

const LIVE = id(77)
const VENUE = '0x00000000000000000000000000000000000000aa' as Hex
const T = INFO.tau

type Opts = { info?: Partial<MarketInfo>; status?: Partial<AssertionStatus>; ledger?: bigint; bond?: bigint; minInterval?: bigint; realEngine?: boolean; finalYes?: Hex }

async function plan(r: Partial<Resolution>, now: bigint, o: Opts = {}) {
  const res = resolution({ voidDeadline: 0n, haltedAt: 0n, ...r })
  const alerts: string[] = []
  const reads: string[] = []
  const v: MarketView = {
    id: id(1),
    resolution: res,
    stateVersion: stateVersion(res),
    now,
    info: { ...INFO, ...o.info },
    engineIdentity: o.realEngine ? BOOK_IDENTITY : STUB_IDENTITY,
    reads: {
      assertionStatus: async () => (reads.push('status'), { exists: true, disputed: false, settled: false, truthful: false, expiresAt: 0n, ...o.status }),
      assertionLedger: async () => (reads.push('ledger'), o.ledger ?? 10_000_000_000n),
      bondFor: async () => (reads.push('bond'), o.bond ?? 2_000_000n),
      minRequestIntervalSecs: async () => (reads.push('interval'), o.minInterval ?? 60n),
      groupFinalYes: async () => (reads.push('group'), o.finalYes ?? (`0x${'00'.repeat(32)}` as Hex)),
      settlementStatus: async () => {
        throw new Error('the resolution jobs never read the engine')
      },
    },
    alert: (msg) => alerts.push(msg),
  }
  const jobs = await resolutionPlanner()(v)
  return { jobs, job: jobs[0] as Job | undefined, alerts, reads, v }
}
const action = async (r: Partial<Resolution>, now: bigint, o: Opts = {}) => (await plan(r, now, o)).job?.action ?? null

describe('every planned job names a measured gas limit', () => {
  test('testnet keys exist in gas.json; mainnet keys without a measurement are refused by the keeper, not guessed', async () => {
    const cases: [Partial<Resolution>, bigint, Opts?][] = [
      [{ state: RState.L2Pending, voidDeadline: 5000n }, 5000n],
      [{ state: RState.Disputed, voidDeadline: 5000n, assertionId: LIVE, assertionVenue: VENUE }, 5000n],
      [{ state: RState.None }, T],
      [{ state: RState.EarlyCheck, earlyStartedAt: 100n }, 700n],
      [{ state: RState.L1Pending }, T + 300n],
      [{ state: RState.L1Pending }, T + 60n],
      [{ state: RState.L2Pending, l2StartedAt: T }, T + 600n],
      [{ state: RState.Proposed }, T],
      [{ state: RState.Proposed, assertionId: LIVE, assertionVenue: VENUE }, T, { status: { disputed: true } }],
      [{ state: RState.Proposed, assertionId: LIVE, assertionVenue: VENUE }, T + 400n, { status: { expiresAt: T + 300n } }],
    ]
    for (const [r, now, o] of cases) {
      const { job } = await plan(r, now, o)
      expect(job, JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? String(x) : x))).toBeDefined()
      expect(() => gasLimit(GAS, job!.gasKey), job!.gasKey).not.toThrow()
    }
    expect((await plan({ state: RState.None }, T, { realEngine: true })).job?.gasKey).toBe('haltScheduledRealEngine')
    expect((await plan({ state: RState.L2Pending, voidDeadline: 5000n }, 5000n, { realEngine: true })).job?.gasKey).toBe('voidMarketRealEngine')
    expect(() => gasLimit(withoutGasLimits('voidMarketRealEngine'), 'voidMarketRealEngine')).toThrow()
  })
})

describe('void', () => {
  test('from voidDeadline on, any non-Final market; the stuck key when an assertion is live', async () => {
    expect(await action({ state: RState.L2Pending, voidDeadline: 5000n }, 5000n)).toBe('void')
    expect((await plan({ state: RState.L2Pending, voidDeadline: 5000n }, 5000n)).job?.gasKey).toBe('voidMarket')
    expect((await plan({ state: RState.Disputed, voidDeadline: 5000n, assertionId: LIVE }, 5001n)).job?.gasKey).toBe('voidMarketStuck')
    expect(await action({ state: RState.Review, voidDeadline: 5000n }, 6000n)).toBe('void') // wins over open
  })
  test('no-op: before the deadline, without one (pre-halt), or once Final', async () => {
    expect(await action({ state: RState.L2Pending, voidDeadline: 5000n, l2StartedAt: 4900n }, 4999n)).toBeNull()
    expect(await action({ state: RState.None, voidDeadline: 0n }, T - 1n)).toBeNull()
    expect(await action({ state: RState.Final, voidDeadline: 5000n }, 9000n)).toBeNull()
  })
})

describe('halt', () => {
  test('pre-halt states at and after T', async () => {
    for (const state of [RState.None, RState.EarlyCheck, RState.EarlyReview]) {
      expect(await action({ state, earlyStartedAt: T }, T)).toBe('halt')
    }
  })
  test('no-op: before T, or once halted', async () => {
    expect(await action({ state: RState.None }, T - 1n)).toBeNull()
    expect(await action({ state: RState.L1Pending }, T)).toBeNull()
  })
})

describe('expire early', () => {
  test('EarlyCheck or EarlyReview once earlyStartedAt + earlyTtlSecs has passed (before T)', async () => {
    expect(await action({ state: RState.EarlyCheck, earlyStartedAt: 100n }, 700n)).toBe('expire-early')
    expect(await action({ state: RState.EarlyReview, earlyStartedAt: 100n }, 900n)).toBe('expire-early')
  })
  test('no-op: TTL running, or None', async () => {
    expect(await action({ state: RState.EarlyCheck, earlyStartedAt: 100n }, 699n)).toBeNull()
    expect(await action({ state: RState.None, earlyStartedAt: 0n }, 900n)).toBeNull()
  })
})

describe('Layer 1: escalate and request', () => {
  test('escalate at T + l1TimeoutSecs, ahead of another request', async () => {
    expect(await action({ state: RState.L1Pending }, T + 300n)).toBe('escalate')
    expect(await action({ state: RState.L1Pending, lastRequestAt: T + 60n }, T + 400n)).toBe('escalate')
  })
  test('request from T + bufferSecs, then every 5 minutes (or the onchain floor if longer)', async () => {
    expect(await action({ state: RState.L1Pending }, T + 60n, { info: { l1TimeoutSecs: 3600n } })).toBe('request')
    const o = { info: { l1TimeoutSecs: 3600n } }
    expect(await action({ state: RState.L1Pending, lastRequestAt: T + 60n }, T + 359n, o)).toBeNull()
    expect(await action({ state: RState.L1Pending, lastRequestAt: T + 60n }, T + 360n, o)).toBe('request')
    expect(await action({ state: RState.L1Pending, lastRequestAt: T + 60n }, T + 360n, { ...o, minInterval: 600n })).toBeNull()
    expect(await action({ state: RState.L1Pending, lastRequestAt: T + 60n }, T + 660n, { ...o, minInterval: 600n })).toBe('request')
  })
  test('no-op: before T + bufferSecs (the contract reverts TooEarly) or without a feed (NoFeed)', async () => {
    expect(await action({ state: RState.L1Pending }, T + 59n)).toBeNull()
    expect(await action({ state: RState.L1Pending }, T + 100n, { info: { hasFeed: false, l1TimeoutSecs: 3600n } })).toBeNull()
  })
})

describe('open', () => {
  test('L2Pending or Review past l2StartedAt + l2DeadlineSecs, or past retryOpensAt when set', async () => {
    expect(await action({ state: RState.L2Pending, l2StartedAt: T + 10n }, T + 610n)).toBe('open')
    expect(await action({ state: RState.Review, l2StartedAt: T, retryOpensAt: T + 5000n }, T + 5000n)).toBe('open')
  })
  test('no-op: before the deadline, before retryOpensAt even past the deadline, or before T (early halt)', async () => {
    expect(await action({ state: RState.L2Pending, l2StartedAt: T + 10n }, T + 609n)).toBeNull()
    expect(await action({ state: RState.Review, l2StartedAt: T, retryOpensAt: T + 5000n }, T + 4999n)).toBeNull()
    expect(await action({ state: RState.L2Pending, l2StartedAt: 0n }, T - 1n)).toBeNull()
  })
})

describe('assert', () => {
  test('Proposed without a live assertion when the ASSERTION ledger holds the bond', async () => {
    const p = await plan({ state: RState.Proposed }, T, { ledger: 2_000_000n, bond: 2_000_000n })
    expect(p.job?.action).toBe('assert')
    expect(p.alerts).toEqual([])
  })
  test('no-op with an alert: the ledger is short, or every attempt is used', async () => {
    const short = await plan({ state: RState.Proposed }, T, { ledger: 1_999_999n, bond: 2_000_000n })
    expect(short.job).toBeUndefined()
    expect(short.alerts).toEqual(['treasury short: the ASSERTION ledger cannot fund the bond'])
    const used = await plan({ state: RState.Proposed, attempts: 3 }, T)
    expect(used.job).toBeUndefined()
    expect(used.alerts).toEqual(['Proposed with every assertion attempt used'])
    expect(used.reads).toEqual([]) // no treasury read needed
  })
})

describe('sync dispute and finalize', () => {
  const live = { assertionId: LIVE, assertionVenue: VENUE }
  test('sync when the venue shows the live assertion disputed and unsettled', async () => {
    expect(await action({ state: RState.Proposed, ...live }, T, { status: { disputed: true, expiresAt: T + 300n } })).toBe('sync')
    // A dispute the DVM already settled is applied directly by finalize, not first synced.
    expect(await action({ state: RState.Proposed, ...live }, T, { status: { disputed: true, settled: true, expiresAt: T + 300n } })).toBe('finalize')
  })
  test('finalize: past expiresAt, settled on the venue, or Disputed (the DVM may have answered); batched on testnet', async () => {
    const p = await plan({ state: RState.Proposed, ...live }, T + 300n, { status: { expiresAt: T + 300n } })
    expect(p.job?.action).toBe('finalize')
    expect(p.job?.batch?.key).toBe('finalize')
    expect(await action({ state: RState.Proposed, ...live }, T, { status: { settled: true, expiresAt: T + 300n } })).toBe('finalize')
    expect(await action({ state: RState.Disputed, ...live }, T, { status: { disputed: true, expiresAt: T + 300n } })).toBe('finalize')
    const real = await plan({ state: RState.Proposed, ...live }, T + 300n, { status: { expiresAt: T + 300n }, realEngine: true })
    expect([real.job?.gasKey, real.job?.batch]).toEqual(['finalizeMarketRealEngine', undefined])
  })
  test('no-op: liveness running and undisputed; a simulated NOT_READY; DISPUTED again from Disputed', async () => {
    expect(await action({ state: RState.Proposed, ...live }, T + 299n, { status: { expiresAt: T + 300n } })).toBeNull()
    const proposed = (await plan({ state: RState.Proposed, ...live }, T + 300n, { status: { expiresAt: T + 300n } })).job!
    expect(proposed.isNoop!(FinalizeStatus.NOT_READY)).toBe(true)
    expect(proposed.isNoop!(FinalizeStatus.DISPUTED)).toBe(false) // Proposed -> Disputed is a change
    expect(proposed.isNoop!(FinalizeStatus.FINAL)).toBe(false)
    const disputed = (await plan({ state: RState.Disputed, ...live }, T, { status: { disputed: true } })).job!
    expect(disputed.isNoop!(FinalizeStatus.DISPUTED)).toBe(true)
    expect(disputed.isNoop!(FinalizeStatus.REJECTED)).toBe(false)
  })
  test('states with nothing to do: Open, Final, a Proposed market without a venue read when none is live', async () => {
    expect(await action({ state: RState.Open }, T + 9999n)).toBeNull()
    expect(await action({ state: RState.Final }, T + 9999n)).toBeNull()
  })
})

describe('finalize batching through the keeper', () => {
  const ids = [1, 2, 3, 4, 5, 6].map(id)
  function setup() {
    const chain = new FakeChain(ids)
    for (const m of ids) chain.markets.set(m, resolution({ state: RState.Proposed, assertionId: LIVE, assertionVenue: VENUE, voidDeadline: 0n }))
    chain.status = { exists: true, disputed: false, settled: false, truthful: false, expiresAt: 4000n }
    chain.simResult.set('finalizeMarket', FinalizeStatus.FINAL)
    return chain
  }

  test('due markets go out as finalizeMany in runs of at most 4, each run with its measured limit', async () => {
    const chain = setup()
    const k = new Keeper({ chain, source: new StaticSource(ids), planners: [resolutionPlanner()], gas: GAS })
    const r = await k.tick()
    expect(r.results.map((x) => x.outcome)).toEqual(Array(6).fill('sent'))
    expect(chain.sends.map((s) => [s.job.target, s.job.functionName, (s.job.args[0] as Hex[]).length, s.gas])).toEqual([
      ['KeeperRouter', 'finalizeMany', 4, gasLimit(GAS, 'finalizeMany4')],
      ['KeeperRouter', 'finalizeMany', 2, finalizeManyGas(GAS, 2)],
    ])
    expect(new Set(r.results.slice(0, 4).map((x) => x.hash)).size).toBe(1)
    expect(await k.tick().then((t) => t.results.map((x) => x.outcome))).toEqual(Array(6).fill('duplicate'))
  })

  test('a run of one is sent as finalizeMarket; members that fail their checks are left out of the batch', async () => {
    const chain = setup()
    chain.revertSim.add(ids[1])
    for (const m of ids.slice(2)) chain.markets.set(m, resolution({ state: RState.Open, voidDeadline: 0n }))
    const k = new Keeper({ chain, source: new StaticSource(ids), planners: [resolutionPlanner()], gas: GAS })
    const r = await k.tick()
    expect(r.results.map((x) => x.outcome).sort()).toEqual(['reverts', 'sent'])
    expect(chain.sends.map((s) => [s.job.functionName, s.gas])).toEqual([['finalizeMarket', gasLimit(GAS, 'finalizeMarket')]])
  })

  test('nothing to apply yet (NOT_READY) sends nothing', async () => {
    const chain = setup()
    chain.simResult.set('finalizeMarket', FinalizeStatus.NOT_READY)
    const k = new Keeper({ chain, source: new StaticSource(ids), planners: [resolutionPlanner()], gas: GAS })
    expect((await k.tick()).results.map((x) => x.outcome)).toEqual(Array(6).fill('noop'))
    expect(chain.sends).toHaveLength(0)
  })

  test('the batch limit is the line through the two measured limits, and only measured sizes are allowed', () => {
    expect(finalizeManyGas(GAS, 1)).toBe(gasLimit(GAS, 'finalizeMany1'))
    expect(finalizeManyGas(GAS, 4)).toBe(gasLimit(GAS, 'finalizeMany4'))
    expect(finalizeManyGas(GAS, 2)).toBe(gasLimit(GAS, 'finalizeMany1') + 300_000n)
    expect(() => finalizeManyGas(GAS, 5)).toThrow(/not measured/)
    expect(() => finalizeManyGas(GAS, 0)).toThrow(/not measured/)
    expect(FINALIZE_BATCH.max).toBe(4)
  })

  test('the listing is read once per market, not every tick', async () => {
    const chain = setup()
    const k = new Keeper({ chain, source: new StaticSource(ids), planners: [resolutionPlanner()], gas: GAS })
    await k.tick()
    await k.tick()
    expect(chain.infoReads).toBe(6)
  })
})

describe('exclusive group conflict', () => {
  const GROUP = `0x${'0b'.repeat(32)}` as Hex
  const OTHER = `0x${'0c'.repeat(32)}` as Hex
  const proposedYes = { state: RState.Proposed, proposed: 1, assertionId: `0x${'00'.repeat(32)}` as Hex }

  test('a Proposed YES in a group with a Final YES is sent as the conflict, not refused as a no-op', async () => {
    const p = await plan(proposedYes, T + 1n, { info: { groupId: GROUP, groupExclusive: true }, finalYes: OTHER })
    expect(p.job?.action).toBe('group-conflict')
    expect(p.job?.functionName).toBe('assertProposal')
    expect(p.job?.isNoop?.(false)).toBe(false)
  })

  test('without a Final YES in the group, or outside a group, it is the ordinary assertion', async () => {
    expect(await action(proposedYes, T + 1n, { info: { groupId: GROUP, groupExclusive: true } })).toBe('assert')
    expect(await action(proposedYes, T + 1n, { finalYes: OTHER })).toBe('assert')
    expect(await action({ ...proposedYes, proposed: 2 }, T + 1n, { info: { groupId: GROUP, groupExclusive: true }, finalYes: OTHER })).toBe('assert')
  })

  test('the keeper sends it although the simulated assertProposal returns false', async () => {
    const chain = new FakeChain([id(1)])
    chain.time = T + 1n
    chain.info = { ...INFO, groupId: GROUP, groupExclusive: true }
    chain.finalYes = OTHER
    chain.markets.set(id(1), resolution({ ...proposedYes, voidDeadline: 0n }))
    chain.simResult.set('assertProposal', false)
    const k = new Keeper({ chain, source: new StaticSource([id(1)]), planners: [resolutionPlanner()], gas: GAS })
    const r = await k.tick()
    expect(r.results.map((x) => x.outcome)).toEqual(['sent'])
    expect(chain.sends[0].job.functionName).toBe('assertProposal')
  })
})
