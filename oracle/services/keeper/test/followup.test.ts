import { describe, expect, test } from 'bun:test'
import { type GasTable, gasLimit, ORACLE_ROOT } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { engineFollowUpAbi, EngineOutcome, InvalidReadiness } from '../src/engineAbi'
import { CHUNK, enginePlanner, engineVersion } from '../src/jobs/engine'
import { RState } from '../src/jobs/resolution'
import { commitmentsCheck, treasuryPlanner } from '../src/jobs/treasury'
import { Keeper } from '../src/keeper'
import { StaticSource } from '../src/sources'
import type { Logger } from '../src/types'
import { stateVersion } from '../src/version'
import { BOOK_IDENTITY, ENGINE, FakeChain, GAS, id, resolution, SETTLEMENT, testEngineGas, withoutGasLimits, ZERO32 } from './fake'

/** gas.json plus stand-in limits for the engine calls, which are not measured yet. */
const WITH_ENGINE: GasTable = {
  ...GAS,
  calls: {
    ...GAS.calls,
    captureInvalidPrice: testEngineGas(1),
    finishPreparation: testEngineGas(2),
    preparePayoutChunk32: testEngineGas(3),
    prepareSnapshotChunk32: testEngineGas(4),
  },
}

function logger() {
  const alerts: string[] = []
  const errors: string[] = []
  const log: Logger = {
    info() {},
    warn() {},
    error: (msg, data) => (data?.alert ? alerts.push(msg) : errors.push(msg)),
  }
  return { log, alerts, errors }
}

function finalMarket(chain: FakeChain) {
  chain.identities.set(ENGINE, BOOK_IDENTITY)
  chain.markets.set(id(1), resolution({ state: RState.Final, voidDeadline: 0n, outcome: 1 }))
}

const engineKeeper = (chain: FakeChain, gas = WITH_ENGINE, log?: Logger) =>
  new Keeper({ chain, source: new StaticSource([id(1)]), planners: [enginePlanner()], gas, log })

describe('engine follow-up after Final', () => {
  test('the next step is sent: snapshot chunk, then payout chunk, then finish (each later step reverts until due)', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.revertFn.add('finishPreparation').add('preparePayoutChunk')
    const k = engineKeeper(chain)
    let r = await k.tick()
    expect(r.results.map((x) => [x.job.functionName, x.outcome])).toEqual([
      ['finishPreparation', 'reverts'], ['preparePayoutChunk', 'reverts'], ['prepareSnapshotChunk', 'sent'],
    ])
    expect(chain.sends.map((s) => [s.job.address, s.job.args[0], s.gas])).toEqual([[ENGINE, CHUNK, 4n]])

    chain.settlement = { ...chain.settlement, snapshotCursor: 32n } // the chunk landed: a new version, a new key
    r = await k.tick()
    expect(r.results.at(-1)?.outcome).toBe('sent')
    expect(chain.sends).toHaveLength(2)

    chain.revertFn.delete('preparePayoutChunk')
    chain.settlement = { ...chain.settlement, snapshotCursor: 64n }
    r = await k.tick()
    expect(r.results.map((x) => [x.job.functionName, x.outcome])).toEqual([['finishPreparation', 'reverts'], ['preparePayoutChunk', 'sent']])

    chain.revertFn.delete('finishPreparation')
    chain.settlement = { ...chain.settlement, payoutCursor: 64n, accountingComplete: true }
    r = await k.tick()
    expect(r.results.map((x) => [x.job.functionName, x.outcome])).toEqual([['finishPreparation', 'sent']])
  })

  test('a chunk is not sent twice while the engine shows the same progress', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.revertFn.add('finishPreparation').add('preparePayoutChunk')
    const k = engineKeeper(chain)
    await k.tick()
    const again = await k.tick()
    expect(again.results.at(-1)?.outcome).toBe('duplicate')
    expect(chain.sends).toHaveLength(1)
  })

  test('progress made between planning and sending makes the job stale', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.revertFn.add('finishPreparation').add('preparePayoutChunk')
    const k = new Keeper({
      chain, source: new StaticSource([id(1)]), planners: [enginePlanner()], gas: WITH_ENGINE, delayMs: 1,
      sleep: async () => {
        chain.settlement = { ...chain.settlement, snapshotCursor: 32n } // another keeper's chunk landed
      },
    })
    const r = await k.tick()
    expect(r.results.map((x) => x.outcome)).toEqual(['stale']) // the first job is already stale: nothing further tried
    expect(chain.sends).toHaveLength(0)
  })

  test('INVALID without a price: only the capture, which is a no-op until a price can be captured', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.settlement = { ...chain.settlement, finalOutcome: EngineOutcome.INVALID }
    chain.simResult.set('captureInvalidPrice', [InvalidReadiness.WAIT_GRACE, false])
    const k = engineKeeper(chain)
    expect((await k.tick()).results.map((x) => [x.job.functionName, x.outcome])).toEqual([['captureInvalidPrice', 'noop']])
    chain.simResult.set('captureInvalidPrice', [InvalidReadiness.CAPTURE_FALLBACK, true])
    expect((await k.tick()).results.map((x) => [x.job.functionName, x.outcome])).toEqual([['captureInvalidPrice', 'sent']])
    chain.settlement = { ...chain.settlement, invalidPriceReady: true } // captured: preparation follows
    chain.revertFn.add('finishPreparation').add('preparePayoutChunk')
    expect((await k.tick()).results.at(-1)?.job.functionName).toBe('prepareSnapshotChunk')
  })

  test('nothing before Final, once claims are enabled (the testnet stub at once), or before the halt', async () => {
    for (const [r, s] of [
      [resolution({ state: RState.Proposed, voidDeadline: 0n }), SETTLEMENT],
      [resolution({ state: RState.Final, voidDeadline: 0n }), { ...SETTLEMENT, claimsEnabled: true }],
      [resolution({ state: RState.Final, voidDeadline: 0n }), { ...SETTLEMENT, halted: false }],
    ] as const) {
      const chain = new FakeChain()
      chain.markets.set(id(1), r)
      chain.settlement = { ...s }
      expect((await engineKeeper(chain).tick()).results).toEqual([])
    }
  })

  test('RECOVERY_REQUIRED alerts Risk and sends nothing', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.settlement = { ...chain.settlement, recoveryRequired: true }
    const { log, alerts } = logger()
    expect((await engineKeeper(chain, WITH_ENGINE, log).tick()).results).toEqual([])
    expect(alerts).toEqual(['engine RECOVERY_REQUIRED: claims stay disabled (Risk on-call)'])
  })

  test('an engine call without a configured limit is refused', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    const { log, errors } = logger()
    const r = await engineKeeper(chain, withoutGasLimits('finishPreparation'), log).tick()
    expect(r.results.map((x) => x.outcome)).toEqual(['no-gas-limit'])
    expect(errors).toEqual(['no measured gas limit: job not sent'])
    expect(chain.sends).toHaveLength(0)
  })

  test('the engine version moves with every status field the jobs depend on', () => {
    const v = stateVersion(resolution())
    const seen = new Set([engineVersion(v, SETTLEMENT)])
    const edits: Partial<typeof SETTLEMENT>[] = [
      { halted: false }, { finalOutcome: 3 }, { invalidPriceReady: true }, { snapshotCursor: 1n }, { payoutCursor: 1n },
      { accountCount: 1n }, { claimsEnabled: true }, { accountingComplete: true }, { recoveryRequired: true },
    ]
    for (const e of edits) {
      const x = engineVersion(v, { ...SETTLEMENT, ...e })
      expect(seen.has(x), JSON.stringify(e, (_, y) => (typeof y === 'bigint' ? String(y) : y))).toBe(false)
      seen.add(x)
    }
    expect(engineVersion(stateVersion(resolution({ outcome: 2 })), SETTLEMENT)).not.toBe(engineVersion(v, SETTLEMENT))
  })

  test('the engine ABI copy is what Risk\'s SettlementController compiles to (forge inspect EngineHarness)', () => {
    const p = Bun.spawnSync(['forge', 'inspect', 'EngineHarness', 'abi', '--json'], {
      cwd: ORACLE_ROOT, stdout: 'pipe', stderr: 'pipe',
    })
    expect(p.exitCode, p.stderr.toString().slice(-300)).toBe(0)
    const abi = JSON.parse(p.stdout.toString()) as { type: string; name?: string }[]
    for (const f of engineFollowUpAbi) expect(abi.find((x) => x.type === 'function' && x.name === f.name)).toEqual(f as never)
  }, 600_000)
})

describe('treasury disputes and skim', () => {
  const A1 = id(101)
  const A2 = id(102)
  const VENUE = '0x00000000000000000000000000000000000000aa' as Hex

  function setup() {
    const chain = new FakeChain([])
    chain.disputes.set(A1, { marketId: id(1), venue: VENUE, bond: 2_000_000n })
    chain.disputes.set(A2, { marketId: id(2), venue: VENUE, bond: 2_000_000n })
    chain.simResult.set('skim', 0n)
    return chain
  }
  const keeper = (chain: FakeChain, ids: Hex[] = [A1, A2]) =>
    new Keeper({ chain, source: new StaticSource([]), planners: [], globalPlanners: [treasuryPlanner({ assertionIds: async () => ids })], gas: GAS })

  test('closeDispute for each open dispute the call would close, then skim when it credits', async () => {
    const chain = setup()
    chain.simResult.set('closeDispute', true)
    chain.simResult.set('skim', 7_000_000n)
    const r = await keeper(chain).tick()
    expect(r.results.map((x) => [x.job.functionName, x.job.args[0] ?? null, x.outcome])).toEqual([
      ['closeDispute', A1, 'sent'], ['closeDispute', A2, 'sent'], ['skim', null, 'sent'],
    ])
    expect(chain.sends.map((s) => s.gas)).toEqual([gasLimit(GAS, 'closeDispute'), gasLimit(GAS, 'closeDispute'), gasLimit(GAS, 'skim')])
  })

  test('no-op: a dispute still running (the call returns false), nothing to skim, a dispute already closed', async () => {
    const chain = setup()
    chain.simResult.set('closeDispute', false)
    chain.disputes.set(A2, { marketId: ZERO32, venue: `0x${'00'.repeat(20)}`, bond: 0n }) // closed
    const r = await keeper(chain).tick()
    expect(r.results.map((x) => [x.job.functionName, x.outcome])).toEqual([['closeDispute', 'noop'], ['skim', 'noop']])
    expect(chain.sends).toHaveLength(0)
  })

  test('a dispute closed between planning and sending is stale; a closed dispute is not read again', async () => {
    const chain = setup()
    chain.simResult.set('closeDispute', true)
    const k = new Keeper({
      chain, source: new StaticSource([]), planners: [], gas: GAS, delayMs: 1,
      globalPlanners: [treasuryPlanner({ assertionIds: async () => [A1] })],
      sleep: async () => {
        chain.disputes.set(A1, { marketId: ZERO32, venue: `0x${'00'.repeat(20)}`, bond: 0n })
      },
    })
    expect((await k.tick()).results.map((x) => [x.job.functionName, x.outcome])).toEqual([['closeDispute', 'stale'], ['skim', 'noop']])
    let reads = 0
    const orig = chain.treasuryDispute.bind(chain)
    chain.treasuryDispute = async (a) => (reads++, orig(a))
    await k.tick()
    await k.tick()
    expect(reads).toBe(1) // seen closed once, then skipped
  })

  test('a skim is sent once per treasury state; a new deposit or credit is a new key', async () => {
    const chain = setup()
    chain.simResult.set('skim', 1n)
    const k = keeper(chain, [])
    expect((await k.tick()).results.map((x) => x.outcome)).toEqual(['sent'])
    expect((await k.tick()).results.map((x) => x.outcome)).toEqual(['duplicate'])
    chain.treasury = { ...chain.treasury, watchdogFloat: chain.treasury.watchdogFloat + 1n }
    expect((await k.tick()).results.map((x) => x.outcome)).toEqual(['sent'])
  })
})

describe('hourly commitments check', () => {
  function setup(ledger: bigint, committed: bigint, bond: bigint) {
    const chain = new FakeChain([id(1), id(2)])
    chain.markets.set(id(1), resolution({ state: RState.Proposed, voidDeadline: 0n })) // waiting for its assertion
    chain.markets.set(id(2), resolution({ state: RState.Open, voidDeadline: 0n }))
    chain.treasury = { ...chain.treasury, assertionLedger: ledger, totalCommitted: committed }
    chain.bond = bond
    const { log, alerts } = logger()
    const k = new Keeper({ chain, source: new StaticSource([id(1), id(2)]), planners: [], globalPlanners: [commitmentsCheck()], gas: GAS, log })
    return { chain, k, alerts }
  }

  test('alerts when the ledger is below the commitments or the next bond, and sends nothing', async () => {
    const { chain, k, alerts } = setup(100n, 200n, 150n)
    expect((await k.tick()).results).toEqual([])
    expect(alerts).toEqual(["ASSERTION ledger below the listings' commitments", 'ASSERTION ledger below the next bond'])
    expect(chain.sends).toHaveLength(0)
  })

  test('exactly covered is covered; a market whose assertion is already live needs no next bond', async () => {
    const eq = setup(200n, 200n, 200n)
    await eq.k.tick()
    expect(eq.alerts).toEqual([])
    const live = setup(300n, 200n, 400n)
    live.chain.markets.set(id(1), resolution({ state: RState.Proposed, voidDeadline: 0n, assertionId: id(55) }))
    await live.k.tick()
    expect(live.alerts).toEqual([])
  })

  test('no alert when covered; checked at most hourly by chain time', async () => {
    const ok = setup(300n, 200n, 150n)
    await ok.k.tick()
    expect(ok.alerts).toEqual([])
    const short = setup(100n, 200n, 50n)
    await short.k.tick()
    short.chain.time += 3599n
    await short.k.tick()
    expect(short.alerts).toHaveLength(1)
    short.chain.time += 1n
    await short.k.tick()
    expect(short.alerts).toHaveLength(2)
  })
})

describe('fallbacks in the core', () => {
  test('a job that would revert or change nothing gives way to the next; any other outcome stops the list', async () => {
    const chain = new FakeChain()
    finalMarket(chain)
    chain.revertFn.add('finishPreparation')
    chain.simResult.set('preparePayoutChunk', false)
    const k = new Keeper({
      chain, source: new StaticSource([id(1)]), gas: WITH_ENGINE,
      planners: [async (v) => (await enginePlanner()(v)).map((j) => (j.functionName === 'preparePayoutChunk' ? { ...j, isNoop: (r) => r === false } : j))],
    })
    expect((await k.tick()).results.map((x) => [x.job.functionName, x.outcome])).toEqual([
      ['finishPreparation', 'reverts'], ['preparePayoutChunk', 'noop'], ['prepareSnapshotChunk', 'sent'],
    ])
  })
})
