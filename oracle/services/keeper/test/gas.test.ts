import { describe, expect, test } from 'bun:test'
import type { GasTable } from '@eros-oracle/oracle-sdk'
import { measuredJobGas } from '../src/gas'
import { planners } from '../src/jobs'
import { RState } from '../src/jobs/resolution'
import { Keeper } from '../src/keeper'
import { StaticSource } from '../src/sources'
import type { Job } from '../src/types'
import { BOOK_IDENTITY, ENGINE, FakeChain, GAS, id, resolution, testEngineGas, ZERO32 } from './fake'

const JOB: Job = {
  marketId: id(1), stateVersion: ZERO32, action: 'halt', target: 'ResolutionOracle',
  functionName: 'haltScheduled', args: [id(1)], gasKey: 'haltScheduledRealEngine',
  engineIdentity: { ...BOOK_IDENTITY, address: ENGINE },
}
const table = (entry: GasTable['calls'][string]): GasTable => ({ calls: { [JOB.gasKey]: entry } })

describe('BookRiskEngine gas provenance', () => {
  test('accepts only a sufficient measured limit bound to this chain and runtime', () => {
    expect(measuredJobGas(table(testEngineGas(100)), JOB)).toBe(100n)
    expect(measuredJobGas(table({ ...testEngineGas(100), engine: 'RegistryBookRiskEngine' }), JOB)).toBe(100n)
    expect(() => measuredJobGas(table({ ...testEngineGas(100), limit: 99 }), JOB)).toThrow('below')
    expect(() => measuredJobGas(table({ limit: 100, engine: "B's SettlementController (seam harness)" }), JOB)).toThrow('BookRiskEngine gas provenance')
  })

  test('refuses wrong engine, chain, runtime, missing source, and invalid gas measurements', () => {
    const valid = testEngineGas(100)
    const invalidEntries = [
      { ...valid, limit: 0 },
      { ...valid, limit: -1 },
      { ...valid, limit: 1.5 },
      { ...valid, limit: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, engine: 'SettlementController' },
      { ...valid, engineRuntimeCodehashes: [ZERO32] },
      { ...valid, engineRuntimeCodehashes: [] },
      { ...valid, measurement: { ...valid.measurement, chainId: 143 } },
      { ...valid, measurement: { ...valid.measurement, source: '' } },
      { ...valid, measurement: { ...valid.measurement, source: '   ' } },
      { ...valid, measurement: { ...valid.measurement, transactionGas: 0 } },
      { ...valid, measurement: { ...valid.measurement, transactionGas: -1 } },
      { ...valid, measurement: { ...valid.measurement, transactionGas: 1.5 } },
      { ...valid, measurement: { ...valid.measurement, transactionGas: Number.MAX_SAFE_INTEGER + 1 } },
    ]
    for (const entry of invalidEntries) expect(() => measuredJobGas(table(entry), JOB)).toThrow()
  })

  test('requires the same provenance on settlement preparation calls', () => {
    const job = { ...JOB, target: 'Engine' as const, address: ENGINE, functionName: 'prepareSnapshotChunk', gasKey: 'prepareSnapshotChunk32' }
    expect(() => measuredJobGas({ calls: { prepareSnapshotChunk32: { limit: 100 } } }, job)).toThrow('provenance')
    expect(measuredJobGas({ calls: { prepareSnapshotChunk32: testEngineGas(100) } }, job)).toBe(100n)
  })

  test('the keeper refuses existing seam-harness limits without broadcasting and permits a corrected profile on retry', async () => {
    const chain = new FakeChain()
    chain.identities.set(ENGINE, BOOK_IDENTITY)
    chain.markets.set(id(1), resolution({ state: RState.None, voidDeadline: 0n }))
    const gas = { ...GAS, calls: { ...GAS.calls, haltScheduledRealEngine: { limit: 100, engine: 'SettlementController seam harness' } } }
    const keeper = new Keeper({ chain, source: new StaticSource([id(1)]), planners: planners(), gas })
    expect((await keeper.tick()).results.map((result) => result.outcome)).toEqual(['no-gas-limit'])
    expect(chain.sends).toHaveLength(0)
    expect(keeper.sentKeys()).toHaveLength(0)
    gas.calls.haltScheduledRealEngine = testEngineGas(100)
    expect((await keeper.tick()).results.map((result) => result.outcome)).toEqual(['sent'])
    expect(chain.sends[0].gas).toBe(100n)
  })
})
