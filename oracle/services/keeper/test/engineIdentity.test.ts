import { describe, expect, test } from 'bun:test'
import { gasLimit } from '@eros-oracle/oracle-sdk'
import { type Hex, keccak256 } from 'viem'
import { engineIdentityResolver, type EngineIdentities, parseEngineIdentities } from '../src/engineIdentity'
import { planners } from '../src/jobs'
import { FinalizeStatus, RState } from '../src/jobs/resolution'
import { Keeper } from '../src/keeper'
import { StaticSource } from '../src/sources'
import { BOOK_IDENTITY, ENGINE, FakeChain, GAS, id, INFO, resolution, STUB_IDENTITY, testEngineGas, withoutGasLimits } from './fake'

const REGISTRY = '0x0000000000000000000000000000000000000010' as Hex
const OTHER_ENGINE = '0x0000000000000000000000000000000000000020' as Hex
const THIRD_ENGINE = '0x0000000000000000000000000000000000000030' as Hex
const CONTEXT = { chainId: 10143, registry: REGISTRY }
const STUB_CODE = '0x600160005500' as Hex
const BOOK_CODE = '0x600260005500' as Hex
const IDENTITIES: EngineIdentities = {
  version: 1,
  ...CONTEXT,
  profiles: [
    { kind: 'stub', runtimeCodehash: keccak256(STUB_CODE) },
    { kind: 'book-risk', runtimeCodehash: keccak256(BOOK_CODE) },
  ],
}

describe('engine identity configuration', () => {
  test('binds the identity file to one chain and registry', () => {
    expect(parseEngineIdentities(IDENTITIES, CONTEXT)).toEqual(IDENTITIES)
    expect(() => parseEngineIdentities(IDENTITIES, { ...CONTEXT, chainId: 143 })).toThrow('chainId')
    expect(() => parseEngineIdentities(IDENTITIES, { ...CONTEXT, registry: OTHER_ENGINE })).toThrow('registry')
  })

  test('rejects ambiguous or malformed approval profiles', () => {
    expect(() => parseEngineIdentities({ ...IDENTITIES, profiles: [IDENTITIES.profiles[0], IDENTITIES.profiles[0]] }, CONTEXT)).toThrow('unique')
    expect(() => parseEngineIdentities({ ...IDENTITIES, profiles: [] }, CONTEXT)).toThrow()
    expect(() => parseEngineIdentities({ ...IDENTITIES, profiles: [{ kind: 'real', runtimeCodehash: keccak256(BOOK_CODE) }] }, CONTEXT)).toThrow()
    expect(() => parseEngineIdentities({ ...IDENTITIES, profiles: [{ kind: 'stub', runtimeCodehash: '0x1234' }] }, CONTEXT)).toThrow()
    expect(() => parseEngineIdentities({ ...IDENTITIES, profiles: [{ kind: 'stub', runtimeCodehash: `0x${'00'.repeat(32)}` }] }, CONTEXT)).toThrow()
  })

  test('validates actual runtime code on the configured RPC chain without caching approvals', async () => {
    let rpcChainId = CONTEXT.chainId
    let runtime: Hex | undefined = STUB_CODE
    const resolveIdentity = engineIdentityResolver({
      getChainId: async () => rpcChainId,
      getCode: async () => runtime,
    }, IDENTITIES, CONTEXT)
    expect(await resolveIdentity(ENGINE)).toEqual({ ...IDENTITIES.profiles[0], chainId: CONTEXT.chainId })
    runtime = BOOK_CODE
    expect(await resolveIdentity(ENGINE)).toEqual({ ...IDENTITIES.profiles[1], chainId: CONTEXT.chainId })
    runtime = '0x600360005500'
    await expect(resolveIdentity(ENGINE)).rejects.toThrow('unapproved runtime codehash')
    runtime = '0x'
    await expect(resolveIdentity(ENGINE)).rejects.toThrow('no runtime code')
    runtime = undefined
    await expect(resolveIdentity(ENGINE)).rejects.toThrow('no runtime code')
    runtime = STUB_CODE
    rpcChainId = 143
    await expect(resolveIdentity(ENGINE)).rejects.toThrow('RPC chainId')
  })
})

function dueMarkets() {
  const marketIds = [id(1), id(2), id(3), id(4)]
  const chain = new FakeChain(marketIds)
  chain.infos.set(id(3), { ...INFO, engine: OTHER_ENGINE })
  chain.infos.set(id(4), { ...INFO, engine: THIRD_ENGINE })
  chain.identities.set(OTHER_ENGINE, BOOK_IDENTITY)
  for (const marketId of marketIds) {
    chain.markets.set(marketId, resolution({ state: RState.Proposed, assertionId: id(99), voidDeadline: 0n }))
  }
  chain.simResult.set('finalizeMarket', FinalizeStatus.FINAL)
  return { chain, marketIds }
}

describe('per-market engine routing', () => {
  test('batches only validated stubs, handles a real market separately, and isolates an unknown engine', async () => {
    const { chain, marketIds } = dueMarkets()
    const alerts: string[] = []
    const keeper = new Keeper({
      chain, source: new StaticSource(marketIds), planners: planners(),
      gas: { ...GAS, calls: { ...GAS.calls, finalizeMarketRealEngine: testEngineGas(420_000) } },
      log: { info() {}, warn() {}, error: (message) => { alerts.push(message) } },
    })
    const report = await keeper.tick()
    expect(report.unreadable).toBe(1)
    expect(alerts).toEqual(['engine identity unverified: market skipped'])
    expect(report.results.map((result) => result.outcome)).toEqual(['sent', 'sent', 'sent'])
    expect(chain.sends.map((sent) => [sent.job.functionName, sent.job.gasKey, sent.gas])).toEqual([
      ['finalizeMarket', 'finalizeMarketRealEngine', gasLimit(GAS, 'finalizeMarketRealEngine')],
      ['finalizeMany', 'finalizeMarket', gasLimit(GAS, 'finalizeMany1') + 300_000n],
    ])
    expect(chain.sends[1].job.args).toEqual([[id(1), id(2)]])
  })

  test('revalidates cached markets on the next tick', async () => {
    const chain = new FakeChain()
    chain.markets.set(id(1), resolution({ state: RState.Open, voidDeadline: 0n }))
    const keeper = new Keeper({ chain, source: new StaticSource([id(1)]), planners: planners(), gas: GAS })
    expect((await keeper.tick()).unreadable).toBe(0)
    chain.identities.delete(ENGINE)
    expect((await keeper.tick()).unreadable).toBe(1)
    expect(chain.infoReads).toBe(1)
    expect(chain.sends).toHaveLength(0)
  })

  test('drops an identity that changes between planning and checking while other markets still send', async () => {
    const { chain } = dueMarkets()
    const keeper = new Keeper({
      chain, source: new StaticSource([id(1), id(3)]), planners: planners(), gas: GAS, delayMs: 1,
      sleep: async () => { chain.identities.set(OTHER_ENGINE, STUB_IDENTITY) },
    })
    const report = await keeper.tick()
    expect(report.results.find((result) => result.job.marketId === id(3))?.outcome).toBe('failed')
    expect(report.results.find((result) => result.job.marketId === id(1))?.outcome).toBe('sent')
    expect(chain.sends).toHaveLength(1)
    expect(chain.sends[0].job.gasKey).toBe('finalizeMarket')
  })

  test('rechecks immediately before sending and removes changed members from a stub batch', async () => {
    const { chain } = dueMarkets()
    chain.infos.set(id(2), { ...INFO, engine: THIRD_ENGINE })
    chain.identities.set(THIRD_ENGINE, STUB_IDENTITY)
    const simulate = chain.simulate.bind(chain)
    chain.simulate = async (job) => {
      const result = await simulate(job)
      if (job.marketId === id(2)) chain.identities.set(THIRD_ENGINE, BOOK_IDENTITY)
      return result
    }
    const keeper = new Keeper({ chain, source: new StaticSource([id(1), id(2)]), planners: planners(), gas: GAS })
    const report = await keeper.tick()
    expect(report.results.map((result) => [result.job.marketId, result.outcome])).toEqual([[id(2), 'failed'], [id(1), 'sent']])
    expect(chain.sends.map((sent) => [sent.job.functionName, sent.gas])).toEqual([['finalizeMarket', gasLimit(GAS, 'finalizeMarket')]])
    expect(keeper.sentKeys()).toHaveLength(1)
  })

  test('never runs real settlement preparation on a stub and preserves missing-limit refusal on a real engine', async () => {
    const chain = new FakeChain([id(1), id(2)])
    chain.infos.set(id(2), { ...INFO, engine: OTHER_ENGINE })
    chain.identities.set(OTHER_ENGINE, BOOK_IDENTITY)
    for (const marketId of [id(1), id(2)]) chain.markets.set(marketId, resolution({ state: RState.Final, voidDeadline: 0n }))
    const keeper = new Keeper({ chain, source: new StaticSource([id(1), id(2)]), planners: planners(), gas: withoutGasLimits('finishPreparation') })
    const report = await keeper.tick()
    expect(report.results.map((result) => [result.job.marketId, result.outcome])).toEqual([[id(2), 'no-gas-limit']])
    expect(chain.sends).toHaveLength(0)
  })
})
