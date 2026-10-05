import { describe, expect, test } from 'bun:test'
import { concatHex, getContractError, keccak256, RpcRequestError, stringToHex, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Operations, type Call, type Snapshot, type Transport } from '../src/operations'
import { binding, envelopeSchema, manifestSchema, observationDigest, type Envelope, type Manifest } from '../src/schema'
import type { Journal, Store } from '../src/store'
import { BatchEstimateOpaqueRevert, BatchGasLimitExceeded, isOpaqueBatchEstimateRevert, measuredRolloverBatch, RolloverBatcherAbi, rolloverBatchGas, verifyRolloverHelper } from '../src/rollover-batch'

const fixedHex = (value: number) => toHex(BigInt(value), { size: 32 })
const account = privateKeyToAccount(fixedHex(1))
const engine = '0x1111111111111111111111111111111111111111'
const oracle = '0x2222222222222222222222222222222222222222'
const manifest: Manifest = manifestSchema.parse({
  chainId: 10143, engine, oracle, sender: account.address, engineCodeHash: fixedHex(2),
  oracleCodeHash: fixedHex(3), listingHash: fixedHex(4), marketId: fixedHex(5), sampleEveryBlocks: '2',
  gas: { samplePerp: 100000, requestReduceOnly: 100000, requestEarlyCheck: 100000, submitObservation: 100000 },
})

class MemoryStore implements Store {
  journal: Journal = { version: 1, binding: binding(manifest), completed: [] }
  failWrite = false
  read() { return structuredClone(this.journal) }
  write(journal: Journal) {
    if (this.failWrite) throw new Error('Disk full')
    this.journal = structuredClone(journal)
  }
}

class FakeTransport implements Transport {
  state: Snapshot = {
    block: 100n, timestamp: 1000n, halted: false, scheduledT: 2000n,
    monitor: account.address, monitorRestricted: false, oracleState: 0,
    source: { id: fixedHex(6), signer: account.address, rulesHash: fixedHex(7), configured: true, lastSequence: 0n, lastObservedAt: 900n },
  }
  prepared: Call[] = []
  broadcasts: Hex[] = []
  simulated: Call[] = []
  receiptValue: Awaited<ReturnType<Transport['receipt']>> = null
  envelope?: Envelope
  failBroadcast = false
  failSimulation = false
  liquidationResults = new Map<number, unknown>()
  async snapshot() { return structuredClone(this.state) }
  async digest() { return observationDigest(this.envelope!) }
  async simulate(call: Call) {
    if (this.failSimulation) throw new Error('Simulation reverted')
    this.simulated.push(call)
    if (call.action === 'liquidate') return this.liquidationResults.get(Number(call.args[0]))
      ?? { mode: 0, result: 0, pairedLots: 0n, bookLots: 0n, reason: 0 }
    return false
  }
  async prepare(call: Call) {
    this.prepared.push(call)
    const rawTransaction = toHex(BigInt(this.prepared.length + 100))
    return { rawTransaction, hash: keccak256(rawTransaction) }
  }
  async broadcast(rawTransaction: Hex) {
    this.broadcasts.push(rawTransaction)
    if (this.failBroadcast) throw new Error('RPC disconnected after accepting transaction')
    return keccak256(rawTransaction)
  }
  async receipt() { return this.receiptValue }
}

function setup(configuration = manifest) {
  const transport = new FakeTransport()
  const store = new MemoryStore()
  store.journal.binding = binding(configuration)
  return { transport, store, operations: new Operations(configuration, transport, store) }
}

const sample = { action: 'sample' } as const
const early = { action: 'early-check', incident: { incident: 'operator-confirmed-result-1', reason: fixedHex(9) } } as const

describe('measured bounded rollover batches', () => {
  const configuration: Manifest = { ...manifest, rolloverHelper: {
    address: '0x3333333333333333333333333333333333333333', codeHash: fixedHex(11), maxPages: 32, gasCeiling: 30_000_000,
  } }
  function batchSetup(participants = 1024) {
    const value = setup(configuration)
    value.transport.state.rollover = { timestamp: 1000n, scheduledT: 2000n, halted: false,
      epochId: 1n, epochEnd: 1000n, work: 0, cursor: 0n, count: 0n }
    value.transport.state.liquidation = { participants, accountingState: 1, capLots: 0n, remainingLots: 0n }
    const estimates: { call: Omit<Call, 'gas'>; block: bigint }[] = []
    const transport: FakeTransport & Pick<Transport, 'estimateGas'> = value.transport
    transport.estimateGas = async (call, block) => {
      estimates.push({ call, block })
      return BigInt(Number(call.args[4]) * 2_000_000 + 1_000_000)
    }
    return { ...value, transport, estimates }
  }

  test('selects the largest fitting current estimate, pins the block and keeps the hard ceiling with margin', async () => {
    const value = batchSetup()
    const result = await value.operations.tick({ action: 'rollover' }, true)
    expect(result.outcome).toBe('sent')
    expect(result.rolloverBatch).toMatchObject({ pages: 11, estimatedGas: '23000000', gasLimit: '27610000', estimateBlock: '100' })
    expect(result.rolloverBatch!.estimationMs).toBeGreaterThanOrEqual(0)
    expect(value.transport.prepared[0]).toMatchObject({ target: configuration.rolloverHelper!.address,
      functionName: 'rollover', args: [engine, 1n, 0, 0n, 11], gas: 27_610_000n })
    expect(value.estimates.length).toBeLessThanOrEqual(6)
    expect(value.estimates.every(item => item.block === value.transport.state.block)).toBe(true)
    expect(value.transport.prepared[0].gas).toBeLessThanOrEqual(30_000_000n)
  })

  test('four owners use one page and completed sweeps still estimate an eligible zero-page finish', async () => {
    const small = batchSetup(4)
    await small.operations.tick({ action: 'rollover' })
    expect(small.estimates.map(item => item.call.args[4])).toEqual([1])
    const complete = batchSetup()
    Object.assign(complete.transport.state.rollover!, { work: 1, cursor: 1024n, count: 1024n })
    await complete.operations.tick({ action: 'rollover' })
    expect(complete.estimates.map(item => item.call.args[4])).toEqual([1])
    expect(complete.transport.simulated[0].args).toEqual([engine, 1n, 1, 1024n, 1])
    expect(complete.transport.broadcasts).toHaveLength(0)
  })

  test('only classified gas-cap failures reduce the candidate; custom reverts and transport failures abort', async () => {
    const value = await measuredRolloverBatch(32, 30_000_000n, async pages => {
      if (pages >= 16) throw new BatchGasLimitExceeded('out of gas')
      return BigInt(pages) * 2_000_000n + 1_000_000n
    })
    expect(value).toEqual({ pages: 11, gas: 27_610_000n, estimate: 23_000_000n })
    for (const failure of ['StaleEpoch', 'RPC timeout', 'BadState']) {
      const bad = batchSetup()
      bad.transport.estimateGas = async () => { throw new Error(failure) }
      await expect(bad.operations.tick({ action: 'rollover' }, true)).rejects.toThrow(failure)
      expect(bad.transport.prepared).toHaveLength(0)
      expect(bad.transport.broadcasts).toHaveLength(0)
    }
  })

  test('missing estimates, impossible margin and changed helper identity stop before signing', async () => {
    const missing = batchSetup()
    missing.transport.estimateGas = undefined
    await expect(missing.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('current gas estimation')
    const tooLarge = batchSetup()
    tooLarge.transport.estimateGas = async () => 30_000_000n
    await expect(tooLarge.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('No measured rollover batch fits')
    expect(tooLarge.transport.prepared).toHaveLength(0)
    const changed = batchSetup()
    changed.transport.snapshot = async () => { throw new Error('Rollover helper runtime hash mismatch') }
    await expect(changed.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('helper runtime hash mismatch')
    expect(changed.transport.broadcasts).toHaveLength(0)
  })

  test('recognizes only an exact nested RPC code3 empty revert and rejects custom data or malformed cause chains', () => {
    expect(isOpaqueBatchEstimateRevert({ cause: { raw: '0x', cause: { code: 3, data: '0x' } } })).toBe(true)
    for (const data of ['0x', '0x12345678']) {
      const rpc = new RpcRequestError({ body: { method: 'eth_estimateGas', params: [] },
        error: { code: 3, data, message: 'execution reverted' }, url: 'http://127.0.0.1:18586' })
      const contract = getContractError(rpc, { abi: RolloverBatcherAbi, functionName: 'rollover',
        address: configuration.rolloverHelper!.address, args: [engine, 1n, 0, 0n, 24], sender: account.address })
      expect(isOpaqueBatchEstimateRevert(contract)).toBe(data === '0x')
    }
    for (const error of [new Error('execution reverted'), { code: 3 }, { code: -32000, data: '0x' },
      { code: 3, data: '0x12345678' }, { raw: '0xab', cause: { code: 3, data: '0x' } },
      { code: 3, data: '0x', cause: new Error('transport failed') }]) expect(isOpaqueBatchEstimateRevert(error)).toBe(false)
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle
    expect(isOpaqueBatchEstimateRevert(cycle)).toBe(false)
  })

  test('an opaque larger estimate ends search at the already measured fit and preserves the reason through finality', async () => {
    const value = batchSetup(), candidates: number[] = []
    value.transport.estimateGas = async call => {
      const pages = Number(call.args[4]); candidates.push(pages)
      if (pages === 24) throw new BatchEstimateOpaqueRevert('empty revert')
      return 22_000_000n
    }
    const result = await value.operations.tick({ action: 'rollover' }, true)
    expect(candidates).toEqual([16, 24])
    expect(result.rolloverBatch).toMatchObject({ pages: 16, estimatedGas: '22000000', gasLimit: '26410000', searchStop: { pages: 24, reason: 'opaque-empty-revert' } })
    expect(value.transport.simulated[0].args).toEqual([engine, 1n, 0, 0n, 16])
    expect(value.transport.prepared[0].gas).toBe(26_410_000n)
    value.transport.receiptValue = { status: 'success', block: 101n, finalized: true }
    expect((await value.operations.tick({ action: 'rollover' }, true)).rolloverBatch).toEqual(result.rolloverBatch)
  })

  test('opaque estimation without a prior fit, custom or transport failures after a fit, and retained-fit simulation failures cannot sign', async () => {
    const missing = batchSetup()
    missing.transport.estimateGas = async () => { throw new BatchEstimateOpaqueRevert('no successful estimate') }
    await expect(missing.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('no successful estimate')
    expect(missing.transport.prepared).toHaveLength(0)
    for (const failure of [new Error('custom nonempty revert'), new Error('transport timeout')]) {
      const value = batchSetup()
      value.transport.estimateGas = async call => { if (Number(call.args[4]) > 16) throw failure; return 22_000_000n }
      await expect(value.operations.tick({ action: 'rollover' }, true)).rejects.toThrow(failure.message)
      expect(value.transport.prepared).toHaveLength(0)
    }
    const stale = batchSetup()
    stale.transport.estimateGas = async call => { if (Number(call.args[4]) > 16) throw new BatchEstimateOpaqueRevert('opaque'); return 22_000_000n }
    stale.transport.simulate = async () => { throw new Error('StaleEpoch') }
    await expect(stale.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('StaleEpoch')
    expect(stale.transport.prepared).toHaveLength(0)
  })

  test('epoch/work/cursor races during estimation or simulation discard the plan', async () => {
    for (const update of [{ epochId: 2n }, { work: 0 }, { cursor: 32n }]) {
      const value = batchSetup()
      Object.assign(value.transport.state.rollover!, { work: 1, count: 1024n })
      value.transport.simulate = async () => { Object.assign(value.transport.state.rollover!, update); return false }
      expect((await value.operations.tick({ action: 'rollover' }, true)).outcome).toBe('no-work')
      expect(value.transport.prepared).toHaveLength(0)
    }
  })

  test('one signed batch waits for finality, rebroadcasts exact bytes after interruption, and surfaces revert', async () => {
    const value = batchSetup()
    value.transport.failBroadcast = true
    await expect(value.operations.tick({ action: 'rollover' }, true)).rejects.toThrow('RPC disconnected')
    const pending = structuredClone(value.store.journal.pending)
    value.transport.failBroadcast = false
    const resumed = new Operations(configuration, value.transport, value.store)
    expect((await resumed.tick({ action: 'rollover' }, true)).outcome).toBe('pending')
    expect(value.transport.broadcasts[1]).toBe(pending!.rawTransaction)
    value.transport.receiptValue = { status: 'success', block: 101n, finalized: false }
    expect((await resumed.tick({ action: 'rollover' }, true)).outcome).toBe('pending')
    expect(value.store.journal.pending).toEqual(pending)
    expect(value.transport.prepared).toHaveLength(1)
    value.transport.receiptValue = { status: 'reverted', block: 101n, finalized: true }
    await expect(resumed.tick({ action: 'rollover' }, true)).rejects.toThrow('Transaction reverted')
    expect(value.store.journal.pending).toBeUndefined()
    expect(value.transport.prepared).toHaveLength(1)
  })

  test('helper identity is journal-bound while gas policy stays adjustable and legacy manifests stay supported', () => {
    expect(binding(configuration)).not.toBe(binding(manifest))
    expect(binding({ ...manifest, rolloverHelper: undefined })).toBe(binding(manifest))
    expect(binding({ ...configuration, rolloverHelper: { ...configuration.rolloverHelper!, gasCeiling: 25_000_000, maxPages: 8 } })).toBe(binding(configuration))
    expect(binding({ ...configuration, rolloverHelper: { ...configuration.rolloverHelper!, codeHash: fixedHex(12) } })).not.toBe(binding(configuration))
    expect(binding({ ...configuration, rolloverHelper: { ...configuration.rolloverHelper!, address: oracle } })).not.toBe(binding(configuration))
  })

  test('bounds reject invalid page counts and never fabricate gas', async () => {
    for (const pages of [0, 33, 1.5]) await expect(measuredRolloverBatch(pages, 30_000_000n, async () => 1n)).rejects.toThrow('bounds')
    await expect(measuredRolloverBatch(1, 30_000_001n, async () => 1n)).rejects.toThrow('bounds')
    expect(() => rolloverBatchGas(0n)).toThrow('Invalid')
    expect(() => rolloverBatchGas(-1n)).toThrow('Invalid')
    expect(rolloverBatchGas(101n)).toBe(10_122n)
  })

  test('helper runtime verification reads the exact snapshot block and rejects missing or replaced bytecode', async () => {
    const code = '0x6001600055' as Hex
    const helper = { address: configuration.rolloverHelper!.address, codeHash: keccak256(code) }
    const reads: unknown[] = []
    await verifyRolloverHelper(helper, 123n, async (address, block) => { reads.push([address, block]); return code })
    expect(reads).toEqual([[helper.address, 123n]])
    for (const wrong of [undefined, '0x', '0x6002600055'] as const)
      await expect(verifyRolloverHelper(helper, 123n, async () => wrong)).rejects.toThrow('runtime hash mismatch')
    await verifyRolloverHelper(undefined, 123n, async () => { throw new Error('legacy transport must not read a helper') })
  })
})

describe('bounded epoch rollover', () => {
  const rollover = { action: 'rollover' } as const
  const configuration = { ...manifest, gas: { beginRollover: 300_000, rollPage: 2_000_000, finishRollover: 500_000 } }
  function setupRollover() {
    const value = setup(configuration)
    value.transport.state.rollover = { timestamp: 1000n, scheduledT: 2000n, halted: false,
      epochId: 1n, epochEnd: 1000n, work: 0, cursor: 0n, count: 0n }
    return value
  }

  test('begins, pages in bounded chunks and finishes only after all accounts', async () => {
    const { operations, transport } = setupRollover()
    for (const [state, name, args, gas] of [
      [{ work: 0, cursor: 0n, count: 0n }, 'beginRollover', [], 300_000n],
      [{ work: 1, cursor: 0n, count: 65n }, 'rollPage', [32], 2_000_000n],
      [{ work: 1, cursor: 32n, count: 65n }, 'rollPage', [32], 2_000_000n],
      [{ work: 1, cursor: 64n, count: 65n }, 'rollPage', [32], 2_000_000n],
      [{ work: 1, cursor: 65n, count: 65n }, 'finishRollover', [], 500_000n],
    ] as const) {
      Object.assign(transport.state.rollover!, state)
      expect((await operations.tick(rollover, true)).outcome).toBe('sent')
      expect(transport.prepared.at(-1)).toMatchObject({ functionName: name, args: [...args], gas })
      transport.receiptValue = { status: 'success', block: 101n, finalized: true }
      expect((await operations.tick(rollover, true)).outcome).toBe('finalized')
      transport.receiptValue = null
    }
    Object.assign(transport.state.rollover!, { work: 0, epochId: 2n, epochEnd: 2000n })
    expect((await operations.tick(rollover, true)).outcome).toBe('no-work')
    expect(transport.prepared).toHaveLength(5)
  })

  test('empty sweeps finish without a no-op page; inactive, early, floor and halt states never send', async () => {
    const { operations, transport } = setupRollover()
    Object.assign(transport.state.rollover!, { work: 1 })
    expect((await operations.tick(rollover)).outcome).toBe('planned')
    expect(transport.simulated[0].functionName).toBe('finishRollover')
    for (const fields of [{ work: 0, epochEnd: 1001n }, { epochId: 0n }, { work: 2 }, { work: 3 },
      { halted: true }, { timestamp: 2000n }]) {
      const value = setupRollover()
      Object.assign(value.transport.state.rollover!, fields)
      expect((await value.operations.tick(rollover, true)).outcome).toBe('no-work')
      expect(value.transport.simulated).toHaveLength(0)
      expect(value.transport.broadcasts).toHaveLength(0)
    }
  })

  test('an advanced epoch or page, including advancement to another page, discards the plan', async () => {
    for (const fields of [{ cursor: 32n }, { cursor: 64n }, { work: 0, epochId: 2n, epochEnd: 1500n }, { halted: true }]) {
      const { operations, transport } = setupRollover()
      Object.assign(transport.state.rollover!, { work: 1, count: 64n })
      transport.simulate = async () => { Object.assign(transport.state.rollover!, fields); return false }
      expect((await operations.tick(rollover, true)).outcome).toBe('no-work')
      expect(transport.prepared).toHaveLength(0)
    }
  })

  test('simulation and rechecked identity failures stop before signing', async () => {
    const value = setupRollover()
    value.transport.failSimulation = true
    await expect(value.operations.tick(rollover, true)).rejects.toThrow('Simulation reverted')
    expect(value.transport.prepared).toHaveLength(0)
    const other = setupRollover()
    let snapshots = 0
    other.transport.snapshot = async () => {
      if (++snapshots > 1) throw new Error('Engine runtime hash mismatch')
      return structuredClone(other.transport.state)
    }
    await expect(other.operations.tick(rollover, true)).rejects.toThrow('runtime hash mismatch')
    expect(other.transport.broadcasts).toHaveLength(0)
  })

  test('requires measured gas for each action and rejects missing or unbounded state', async () => {
    for (const fields of [{ work: 0 }, { work: 1, count: 1n }, { work: 1 }]) {
      const { transport, store } = setupRollover()
      Object.assign(transport.state.rollover!, fields)
      await expect(new Operations(manifest, transport, store).tick(rollover, true)).rejects.toThrow('No measured gas')
      expect(transport.broadcasts).toHaveLength(0)
    }
    const value = setupRollover()
    value.transport.state.rollover = undefined
    await expect(value.operations.tick(rollover, true)).rejects.toThrow('Missing rollover snapshot')
    const other = setupRollover()
    other.transport.state.rollover!.count = 1025n
    await expect(other.operations.tick(rollover, true)).rejects.toThrow('Invalid rollover snapshot')
    expect(other.transport.broadcasts).toHaveLength(0)
  })

  test('one pending operation waits for finality and resumes the exact signed transaction', async () => {
    const { operations, transport, store } = setupRollover()
    transport.failBroadcast = true
    await expect(operations.tick(rollover, true)).rejects.toThrow('RPC disconnected')
    transport.failBroadcast = false
    const resumed = new Operations(configuration, transport, store)
    expect((await resumed.tick(rollover, true)).outcome).toBe('pending')
    expect(transport.broadcasts[1]).toBe(transport.broadcasts[0])
    transport.receiptValue = { status: 'success', block: 101n, finalized: false }
    expect((await resumed.tick(rollover, true)).outcome).toBe('pending')
    expect(transport.prepared).toHaveLength(1)
    transport.receiptValue.finalized = true
    expect((await resumed.tick(rollover, true)).outcome).toBe('finalized')
    expect(store.journal.pending).toBeUndefined()
  })

  test('simulation does not mutate the journal and a failed save cannot broadcast', async () => {
    const { operations, transport, store } = setupRollover()
    const before = structuredClone(store.journal)
    expect((await operations.tick(rollover)).outcome).toBe('planned')
    expect(store.journal).toEqual(before)
    expect(transport.prepared).toHaveLength(0)
    store.failWrite = true
    await expect(operations.tick(rollover, true)).rejects.toThrow('Disk full')
    expect(transport.broadcasts).toHaveLength(0)
  })
})

async function signedEnvelope(): Promise<Envelope> {
  const envelope = envelopeSchema.parse({
    chainId: 10143, engine,
    observation: {
      marketId: manifest.marketId, sourceId: fixedHex(6), sequence: '1', observedAt: '990', publishedAt: '995',
      priceWad: '500000000000000000', impactBidWad: '490000000000000000', impactAskWad: '510000000000000000',
      bidDepthLots: '1000', askDepthLots: '1000', sourceRulesHash: fixedHex(7),
    },
    signature: `0x${'00'.repeat(65)}`,
  })
  envelope.signature = await account.sign({ hash: observationDigest(envelope) })
  return envelope
}

describe('sampler and durable transactions', () => {
  test('false simulation still broadcasts the initial state-changing capture', async () => {
    const { operations, transport, store } = setup()
    expect((await operations.tick(sample, true)).outcome).toBe('sent')
    expect(transport.prepared[0].functionName).toBe('samplePerp')
    expect(store.journal.pending?.hash).toBe(keccak256(transport.broadcasts[0]))
  })

  test('default is simulation only without signing', async () => {
    const { operations, transport } = setup()
    expect((await operations.tick(sample)).outcome).toBe('planned')
    expect(transport.prepared).toHaveLength(0)
  })

  test('restarts rebroadcast identical signed bytes without preparing a replacement', async () => {
    const { operations, transport, store } = setup()
    transport.failBroadcast = true
    await expect(operations.tick(sample, true)).rejects.toThrow('RPC disconnected')
    expect(store.journal.pending).toBeDefined()
    transport.failBroadcast = false
    const resumed = new Operations(manifest, transport, store)
    expect((await resumed.tick(sample, true)).outcome).toBe('pending')
    expect(transport.prepared).toHaveLength(1)
    expect(transport.broadcasts[1]).toBe(transport.broadcasts[0])
  })

  test('no broadcast if durable save fails', async () => {
    const { operations, transport, store } = setup()
    store.failWrite = true
    await expect(operations.tick(sample, true)).rejects.toThrow('Disk full')
    expect(transport.broadcasts).toHaveLength(0)
  })

  test('an unfinalized receipt blocks new work and finalized receipt controls block cadence', async () => {
    const { operations, transport } = setup()
    await operations.tick(sample, true)
    transport.receiptValue = { status: 'success', block: 101n, finalized: false }
    expect((await operations.tick(early, true)).outcome).toBe('pending')
    expect(transport.prepared).toHaveLength(1)
    transport.receiptValue.finalized = true
    expect((await operations.tick(sample, true)).outcome).toBe('finalized')
    transport.state.block = 102n
    expect((await operations.tick(sample, true)).outcome).toBe('cadence')
    transport.state.block = 103n
    expect((await operations.tick(sample, true)).outcome).toBe('sent')
  })

  test('revert stops the tick and never chains another operation', async () => {
    const { operations, transport, store } = setup()
    await operations.tick(sample, true)
    transport.receiptValue = { status: 'reverted', block: 101n, finalized: true }
    await expect(operations.tick(early, true)).rejects.toThrow('Transaction reverted')
    expect(transport.prepared).toHaveLength(1)
    expect(store.journal.pending).toBeUndefined()
  })

  test('halts both explicitly and from the listing schedule', async () => {
    const { operations, transport } = setup()
    transport.state.halted = true
    expect((await operations.tick(sample, true)).outcome).toBe('halted')
    transport.state.halted = false
    transport.state.timestamp = transport.state.scheduledT
    expect((await operations.tick(sample, true)).outcome).toBe('halted')
    expect(transport.prepared).toHaveLength(0)
  })

  test('missing gas and failed simulation cannot send', async () => {
    const { operations, transport } = setup({ ...manifest, gas: {} })
    await expect(operations.tick(sample, true)).rejects.toThrow('No measured gas')
    expect(transport.prepared).toHaveLength(0)
    const other = setup()
    other.transport.failSimulation = true
    await expect(other.operations.tick(sample, true)).rejects.toThrow('Simulation reverted')
    expect(other.transport.broadcasts).toHaveLength(0)
  })

  test('concurrent ticks cannot create two pending transactions', async () => {
    const { operations, transport } = setup()
    const outcomes = await Promise.allSettled([operations.tick(sample, true), operations.tick(sample, true)])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(transport.prepared).toHaveLength(1)
  })
})

describe('bounded liquidation operator', () => {
  const liquidate = { action: 'liquidate' } as const
  const configuration = { ...manifest, gas: { ...manifest.gas, liquidate: 2_000_000 } }
  const productive = { mode: 1, result: 2, pairedLots: 0n, bookLots: 100n, reason: 0 }
  function setupLiquidator(participants = 40) {
    const state = setup(configuration)
    state.transport.state.liquidation = { participants, accountingState: 0, capLots: 100n, remainingLots: 100n }
    return state
  }

  test('healthy accounts send nothing and a restart continues after the bounded scan', async () => {
    const { operations, transport, store } = setupLiquidator()
    expect((await operations.tick(liquidate, true)).outcome).toBe('no-work')
    expect(transport.simulated).toHaveLength(32)
    expect(transport.prepared).toHaveLength(0)
    expect(store.journal.liquidationCursor).toBe(33)
    transport.liquidationResults.set(35, productive)
    const restarted = new Operations(configuration, transport, store)
    expect((await restarted.tick(liquidate, true)).outcome).toBe('sent')
    expect(transport.prepared[0].args).toEqual([35, 100n, 8, 0])
    expect(store.journal.liquidationCursor).toBe(36)
  })

  test('unpriced, positive equity without liquidity and disabled takeover are no work', async () => {
    const { operations, transport } = setupLiquidator(3)
    transport.liquidationResults.set(1, { ...productive, bookLots: 0n, reason: 0 })
    transport.liquidationResults.set(2, { ...productive, bookLots: 0n, mode: 2, result: 4 })
    transport.liquidationResults.set(3, { ...productive, bookLots: 0n, reason: 7 })
    expect((await operations.tick(liquidate, true)).outcome).toBe('no-work')
    expect(transport.broadcasts).toHaveLength(0)
  })

  test('authorized nonpositive-equity takeover may send without book liquidity', async () => {
    const { operations, transport } = setupLiquidator(1)
    transport.liquidationResults.set(1, { ...productive, mode: 2, result: 3, bookLots: 0n })
    expect((await operations.tick(liquidate)).outcome).toBe('planned')
    expect(transport.broadcasts).toHaveLength(0)
  })

  test('simulation leaves the cursor and journal untouched', async () => {
    const { operations, store } = setupLiquidator()
    await operations.tick(liquidate)
    expect(store.journal.liquidationCursor).toBeUndefined()
  })

  test('accounting work, pacing exhaustion, 1x and halt stop scanning', async () => {
    for (const fields of [{ accountingState: 1 }, { remainingLots: 0n }, { capLots: 0n }, { participants: 0 }]) {
      const { operations, transport } = setupLiquidator()
      Object.assign(transport.state.liquidation!, fields)
      expect((await operations.tick(liquidate, true)).outcome).toBe('no-work')
      expect(transport.simulated).toHaveLength(0)
    }
    const { operations, transport } = setupLiquidator()
    transport.state.halted = true
    expect((await operations.tick(liquidate, true)).outcome).toBe('halted')
  })

  test('requires measured gas and a bounded participant set', async () => {
    const { operations, transport, store } = setupLiquidator()
    await expect(new Operations(manifest, transport, store).tick(liquidate, true)).rejects.toThrow('No measured gas')
    transport.state.liquidation!.participants = 1025
    await expect(operations.tick(liquidate, true)).rejects.toThrow('invalid liquidation snapshot')
    expect(transport.broadcasts).toHaveLength(0)
  })

  test('a candidate that becomes healthy before final simulation is not sent', async () => {
    const { operations, transport } = setupLiquidator(1)
    let simulations = 0
    transport.simulate = async () => ++simulations === 1 ? productive : { ...productive, bookLots: 0n, mode: 0, result: 0 }
    expect((await operations.tick(liquidate, true)).outcome).toBe('no-work')
    expect(transport.prepared).toHaveLength(0)
  })

  test('failed durable write never sends and a disconnected send replays identical bytes', async () => {
    const { operations, transport, store } = setupLiquidator(1)
    transport.liquidationResults.set(1, productive)
    store.failWrite = true
    await expect(operations.tick(liquidate, true)).rejects.toThrow('Disk full')
    expect(transport.broadcasts).toHaveLength(0)
    store.failWrite = false
    transport.failBroadcast = true
    await expect(operations.tick(liquidate, true)).rejects.toThrow('RPC disconnected')
    transport.failBroadcast = false
    expect((await new Operations(configuration, transport, store).tick(liquidate, true)).outcome).toBe('pending')
    expect(transport.prepared).toHaveLength(1)
    expect(transport.broadcasts[1]).toBe(transport.broadcasts[0])
  })
})

describe('explicit monitor incidents', () => {
  test('restricts before requesting, waits for finality and deduplicates a completed incident', async () => {
    const { operations, transport } = setup()
    await operations.tick(early, true)
    expect(transport.prepared[0].functionName).toBe('requestReduceOnly')
    expect(transport.prepared[0].args).toEqual([early.incident.reason])
    transport.state.monitorRestricted = true
    transport.receiptValue = { status: 'success', block: 101n, finalized: true }
    await operations.tick(early, true)
    await operations.tick(early, true)
    expect(transport.prepared[1].functionName).toBe('requestEarlyCheck')
    transport.state.oracleState = 1
    await operations.tick(early, true)
    expect((await operations.tick(early, true)).outcome).toBe('complete')
    expect(transport.prepared).toHaveLength(2)
  })

  test('wrong monitor, existing oracle request and expired market refuse new work', async () => {
    const { operations, transport } = setup()
    transport.state.monitor = engine
    await expect(operations.tick(early, true)).rejects.toThrow('listing.monitor')
    transport.state.monitor = account.address
    transport.state.oracleState = 1
    await expect(operations.tick(early, true)).rejects.toThrow('state None')
    transport.state.oracleState = 0
    transport.state.timestamp = transport.state.scheduledT
    await expect(operations.tick(early, true)).rejects.toThrow('before T')
    expect(transport.prepared).toHaveLength(0)
  })
})

describe('externally signed INDEX envelopes', () => {
  test('digest equals independently packed ABI words, without an EIP-712 envelope', async () => {
    const envelope = await signedEnvelope()
    const observation = envelope.observation
    const typeHash = keccak256(stringToHex('Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)'))
    const expected = keccak256(concatHex([
      typeHash, observation.marketId, observation.sourceId, ...[
        observation.sequence, observation.observedAt, observation.publishedAt, observation.priceWad,
        observation.impactBidWad, observation.impactAskWad, observation.bidDepthLots, observation.askDepthLots,
      ].map(value => toHex(value, { size: 32 })), observation.sourceRulesHash,
      toHex(BigInt(envelope.chainId), { size: 32 }), toHex(BigInt(engine), { size: 32 }),
    ]))
    expect(observationDigest(envelope)).toBe(expected)
  })

  test('accepts raw digest signature from pinned source and never signs a price', async () => {
    const { operations, transport } = setup()
    transport.envelope = await signedEnvelope()
    expect((await operations.tick({ action: 'relay', envelope: transport.envelope }, true)).outcome).toBe('sent')
    expect(transport.prepared[0].functionName).toBe('submitObservation')
  })

  test('rejects wrong chain, engine, market, source and rules before sending', async () => {
    const envelope = await signedEnvelope()
    const candidates: Envelope[] = [
      { ...envelope, chainId: 143 }, { ...envelope, engine: oracle },
      ...['marketId', 'sourceId', 'sourceRulesHash'].map(field => ({ ...envelope, observation: { ...envelope.observation, [field]: fixedHex(99) } })),
    ]
    for (const candidate of candidates) {
      const { operations, transport } = setup()
      transport.envelope = candidate
      await expect(operations.tick({ action: 'relay', envelope: candidate }, true)).rejects.toThrow()
      expect(transport.broadcasts).toHaveLength(0)
    }
  })

  test('rejects personal_sign, wrong signer, future timestamps and backward time', async () => {
    const envelope = await signedEnvelope()
    const signatures = [
      await account.signMessage({ message: { raw: observationDigest(envelope) } }),
      await privateKeyToAccount(fixedHex(2)).sign({ hash: observationDigest(envelope) }),
    ]
    for (const signature of signatures) {
      const { operations, transport } = setup()
      transport.envelope = envelope
      await expect(operations.tick({ action: 'relay', envelope: { ...envelope, signature } }, true)).rejects.toThrow('signer mismatch')
    }
    for (const times of [{ publishedAt: 1001n }, { observedAt: 899n }, { observedAt: 996n }]) {
      const { operations, transport } = setup()
      transport.envelope = envelope
      await expect(operations.tick({ action: 'relay', envelope: { ...envelope, observation: { ...envelope.observation, ...times } } }, true)).rejects.toThrow()
    }
  })

  test('obsolete sequence is skipped and contract digest mismatch refuses broadcast', async () => {
    const { operations, transport } = setup()
    transport.envelope = await signedEnvelope()
    transport.state.source.lastSequence = 1n
    const command = { action: 'relay', envelope: transport.envelope } as const
    expect((await operations.tick(command, true)).outcome).toBe('obsolete')
    transport.state.source.lastSequence = 0n
    transport.digest = async () => fixedHex(90)
    await expect(operations.tick(command, true)).rejects.toThrow('digest mismatch')
    expect(transport.broadcasts).toHaveLength(0)
  })
})
