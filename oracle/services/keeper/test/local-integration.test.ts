import { describe, expect, test } from 'bun:test'
import { measuredJobGas } from '../src/gas'
import { localGasEntry } from '../src/local-integration'
import type { EngineIdentity } from '../src/engineIdentity'
import type { Job } from '../src/types'

const identity: EngineIdentity = { chainId: 31337, kind: 'book-risk', runtimeCodehash: `0x${'12'.repeat(32)}` }

describe('local keeper gas measurements', () => {
  test('binds the estimate to a real local engine and gives it bounded headroom', () => {
    const entry = localGasEntry(100000n, identity, 'local report#estimate:0')
    expect(entry.limit).toBe(135000)
    expect(entry.measurement.transactionGas).toBe(100000)
    expect(entry.measurement.kind).toBe('local-rpc-estimate')
    const job = { target: 'Engine', gasKey: 'prepareSnapshotChunk32', engineIdentity: identity } as Job
    expect(measuredJobGas({ calls: { prepareSnapshotChunk32: entry } }, job)).toBe(135000n)
  })

  test('will not manufacture a measurement for invalid input, public chain or stub', () => {
    for (const estimate of [0n, -1n, 30000001n]) expect(() => localGasEntry(estimate, identity, 'evidence')).toThrow()
    expect(() => localGasEntry(1n, { ...identity, chainId: 10143 }, 'evidence')).toThrow()
    expect(() => localGasEntry(1n, { ...identity, kind: 'stub' }, 'evidence')).toThrow()
    expect(() => localGasEntry(1n, identity, ' ')).toThrow()
    expect(localGasEntry(29999999n, identity, 'evidence').limit).toBe(30000000)
  })
})
