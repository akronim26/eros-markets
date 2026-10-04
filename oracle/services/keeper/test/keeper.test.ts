import { describe, expect, test } from 'bun:test'
import { gasLimit } from '@eros-oracle/oracle-sdk'
import { Keeper } from '../src/keeper'
import { StaticSource } from '../src/sources'
import type { Job, Planner } from '../src/types'
import { jobKey, stateVersion } from '../src/version'
import { bumpPlanner, FakeChain, GAS, id, resolution } from './fake'

const keeper = (chain: FakeChain, opts: Partial<ConstructorParameters<typeof Keeper>[0]> = {}) =>
  new Keeper({ chain, source: new StaticSource([...chain.markets.keys()]), planners: [bumpPlanner()], gas: GAS, ...opts })
const outcomes = (r: { results: { outcome: string }[] }) => r.results.map((x) => x.outcome)

describe('duplicates', () => {
  test('a job is sent once: later ticks at the same state version skip it until the state moves', async () => {
    const chain = new FakeChain()
    const k = keeper(chain)
    expect(outcomes(await k.tick())).toEqual(['sent'])
    expect(outcomes(await k.tick())).toEqual(['duplicate']) // not mined yet: same version, same key
    expect(outcomes(await k.tick())).toEqual(['duplicate'])
    expect(chain.sends).toHaveLength(1)
    expect(chain.sends[0].gas).toBe(gasLimit(GAS, 'requestResolution')) // the measured limit from gas.json, exactly
  })

  test('the same job executed concurrently is sent once', async () => {
    const chain = new FakeChain()
    const k = keeper(chain)
    const r = resolution()
    const job: Job = { marketId: id(1), stateVersion: stateVersion(r), action: 'request', target: 'ResolutionOracle', functionName: 'requestResolution', args: [id(1)], gasKey: 'requestResolution' }
    const results = await Promise.all([k.execute(job), k.execute(job), k.execute({ ...job })])
    expect(results.map((x) => x.outcome).sort()).toEqual(['duplicate', 'duplicate', 'sent'])
    expect(chain.sends).toHaveLength(1)
  })

  test('the same market listed twice by the source is planned once', async () => {
    const chain = new FakeChain()
    const k = new Keeper({ chain, source: new StaticSource([id(1), id(1), id(1).toUpperCase().replace('0X', '0x') as `0x${string}`]), planners: [bumpPlanner()], gas: GAS })
    const r = await k.tick()
    expect([r.markets, r.unreadable]).toEqual([1, 0])
    expect(outcomes(r)).toEqual(['sent'])
    expect(chain.sends).toHaveLength(1)
  })

  test('once the state moves, the next job gets a new key and old keys are forgotten', async () => {
    const chain = new FakeChain()
    chain.cap = 2
    const k = keeper(chain, { planners: [bumpPlanner(2)] })
    const first = await k.tick()
    chain.mine()
    const second = await k.tick()
    expect(outcomes(second)).toEqual(['sent'])
    expect(second.results[0].key).not.toBe(first.results[0].key)
    chain.mine()
    expect(outcomes(await k.tick())).toEqual([]) // cap reached: nothing due
    expect(k.sentKeys()).toEqual([]) // both keys belonged to older versions
    expect(chain.sends).toHaveLength(2)
  })
})

describe('stale state', () => {
  test('a job planned on a version that changed before sending is dropped', async () => {
    const chain = new FakeChain()
    // The market moves between planning and sending (another keeper's transaction lands during the delay).
    const k = keeper(chain, {
      delayMs: 1,
      sleep: async () => {
        chain.markets.set(id(1), resolution({ requestCount: 0, lastRequestAt: 4999n }))
      },
    })
    const r = await k.tick()
    expect(outcomes(r)).toEqual(['stale'])
    expect(chain.sends).toHaveLength(0)
    expect(k.sentKeys()).toEqual([])
  })

  test('a job for a version that is no longer current is dropped by execute', async () => {
    const chain = new FakeChain()
    const k = keeper(chain)
    const old = stateVersion(resolution({ requestCount: 7 }))
    const r = await k.execute({ marketId: id(1), stateVersion: old, action: 'request', target: 'ResolutionOracle', functionName: 'requestResolution', args: [id(1)], gasKey: 'requestResolution' })
    expect(r.outcome).toBe('stale')
    expect(chain.sends).toHaveLength(0)
  })
})

describe('two instances', () => {
  test('the delayed instance re-reads after the first one landed and sends nothing', async () => {
    const chain = new FakeChain([id(1), id(2)])
    const a = new Keeper({ chain: chain.as('a'), source: new StaticSource([id(1), id(2)]), planners: [bumpPlanner()], gas: GAS })
    const b = new Keeper({
      chain: chain.as('b'),
      source: new StaticSource([id(1), id(2)]),
      planners: [bumpPlanner()],
      gas: GAS,
      delayMs: 30_000,
      sleep: async () => {
        await a.tick()
        chain.mine()
      },
    })
    const rb = await b.tick()
    expect(outcomes(rb)).toEqual(['stale', 'stale'])
    expect(chain.sends.map((s) => s.from)).toEqual(['a', 'a'])
  })

  test('when both send before either lands, the second transaction is a no-op on chain', async () => {
    const chain = new FakeChain()
    const a = new Keeper({ chain: chain.as('a'), source: new StaticSource([id(1)]), planners: [bumpPlanner()], gas: GAS })
    const b = new Keeper({ chain: chain.as('b'), source: new StaticSource([id(1)]), planners: [bumpPlanner()], gas: GAS })
    await Promise.all([a.tick(), b.tick()])
    expect(chain.sends).toHaveLength(2)
    chain.mine()
    expect(chain.markets.get(id(1))!.requestCount).toBe(1) // applied once
    expect([...chain.receipts.values()]).toEqual(['success', 'success']) // neither reverted
    expect(outcomes(await a.tick())).toEqual([])
    expect(outcomes(await b.tick())).toEqual([])
  })
})

describe('gates before sending', () => {
  test('a call the eth_call says would change nothing is not sent, and is re-checked next tick', async () => {
    const chain = new FakeChain()
    chain.cap = 0
    const k = keeper(chain)
    expect(outcomes(await k.tick())).toEqual(['noop'])
    chain.cap = 1
    expect(outcomes(await k.tick())).toEqual(['sent'])
  })

  test('a reverting call is not sent', async () => {
    const chain = new FakeChain()
    chain.revertSim.add(id(1))
    const k = keeper(chain)
    const r = await k.tick()
    expect(outcomes(r)).toEqual(['reverts'])
    expect(r.results[0].error).toContain('NotDue')
    expect(chain.sends).toHaveLength(0)
  })

  test('a call without a measured gas limit is never sent', async () => {
    const chain = new FakeChain()
    const k = keeper(chain, { planners: [bumpPlanner(1, 'notMeasured')] })
    expect(outcomes(await k.tick())).toEqual(['no-gas-limit'])
    expect(chain.sends).toHaveLength(0)
  })

  test('a custom no-op test reads the simulated result', async () => {
    // finalizeMarket returns a FinalizeStatus, not a bool: its job says which results mean "nothing to do".
    const chain = new FakeChain()
    const p: Planner = (m) => (bumpPlanner()(m) as Job[]).map((j) => ({ ...j, isNoop: (r: unknown) => r === true }))
    expect(outcomes(await keeper(chain, { planners: [p] }).tick())).toEqual(['noop'])
    expect(chain.sends).toHaveLength(0)
  })
})

describe('retries', () => {
  test('a failed broadcast is retried next tick', async () => {
    const chain = new FakeChain()
    chain.failSend = 1
    const k = keeper(chain)
    expect(outcomes(await k.tick())).toEqual(['failed'])
    expect(outcomes(await k.tick())).toEqual(['sent'])
    expect(chain.sends).toHaveLength(1)
  })

  test('a transaction that reverted on chain is forgotten and the job sent again', async () => {
    const chain = new FakeChain()
    const k = keeper(chain)
    await k.tick()
    chain.mine(true)
    expect(outcomes(await k.tick())).toEqual(['sent'])
    expect(chain.sends).toHaveLength(2)
  })

  test('a transaction with no receipt past resendAfterMs is forgotten; before that it is not', async () => {
    const chain = new FakeChain()
    let t = 0
    const k = keeper(chain, { clock: () => t, resendAfterMs: 60_000 })
    await k.tick()
    t = 59_000
    expect(outcomes(await k.tick())).toEqual(['duplicate'])
    t = 61_000
    expect(outcomes(await k.tick())).toEqual(['sent'])
  })
})

describe('isolation', () => {
  test('one market per tick gets at most one job, in planner order', async () => {
    const chain = new FakeChain()
    const second: Planner = (m) => [{ ...(bumpPlanner()(m) as Job[])[0], action: 'other' }]
    const r = await keeper(chain, { planners: [bumpPlanner(), second] }).tick()
    expect(r.results.map((x) => x.job.action)).toEqual(['request'])
    const both: Planner = (m) => [...(bumpPlanner()(m) as Job[]), ...(second(m) as Job[])]
    const r2 = await keeper(new FakeChain(), { planners: [both] }).tick()
    expect(r2.results.map((x) => x.job.action)).toEqual(['request'])
  })

  test('an unreadable market, a throwing planner or a planner returning another market\'s job does not stop the others', async () => {
    const chain = new FakeChain([id(1), id(2), id(3), id(4)])
    chain.failRead.add(id(1))
    const planner: Planner = (m) => {
      if (m.id === id(2)) throw new Error('boom')
      if (m.id === id(3)) return [{ ...(bumpPlanner()(m) as Job[])[0], marketId: id(4) }]
      return bumpPlanner()(m)
    }
    const r = await keeper(chain, { planners: [planner] }).tick()
    expect(r.unreadable).toBe(1)
    expect(r.results.map((x) => x.job.marketId)).toEqual([id(4)])
    expect(outcomes(r)).toEqual(['sent'])
  })

  test('a failing source fails the tick; run() logs it and keeps going', async () => {
    const chain = new FakeChain()
    let calls = 0
    const errors: string[] = []
    const stop = new AbortController()
    const k = new Keeper({
      chain,
      source: { marketIds: async () => (++calls === 1 ? Promise.reject(new Error('indexer down')) : [id(1)]) },
      planners: [bumpPlanner()],
      gas: GAS,
      log: { info() {}, warn() {}, error: (m) => errors.push(m) },
      sleep: async () => {
        if (calls >= 2) stop.abort()
      },
    })
    await k.run(1, stop.signal)
    expect(errors).toEqual(['tick failed'])
    expect(chain.sends).toHaveLength(1)
  })
})

describe('options', () => {
  test('an option passed as undefined keeps its default', async () => {
    const chain = new FakeChain()
    chain.failSend = 1
    const k = new Keeper({ chain, source: new StaticSource([id(1)]), planners: [bumpPlanner()], gas: GAS, log: undefined, sleep: undefined })
    expect(outcomes(await k.tick())).toEqual(['failed']) // the failure path logs: the default logger is there
  })
})

describe('job keys', () => {
  test('the key is case-insensitive in the ids and distinct per action', () => {
    const base = { marketId: id(1), stateVersion: stateVersion(resolution()), action: 'request' }
    expect(jobKey(base)).toBe(jobKey({ ...base, marketId: base.marketId.toUpperCase().replace('0X', '0x') as `0x${string}` }))
    expect(jobKey(base)).not.toBe(jobKey({ ...base, action: 'halt' }))
  })
})
