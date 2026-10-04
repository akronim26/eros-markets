import { describe, expect, test } from 'bun:test'
import { concatHex, keccak256, stringToHex, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Operations, type Call, type Snapshot, type Transport } from '../src/operations'
import { binding, envelopeSchema, manifestSchema, observationDigest, type Envelope, type Manifest } from '../src/schema'
import type { Journal, Store } from '../src/store'

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
  async snapshot() { return structuredClone(this.state) }
  async digest() { return observationDigest(this.envelope!) }
  async simulate(call: Call) {
    if (this.failSimulation) throw new Error('Simulation reverted')
    this.simulated.push(call)
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
  return { transport, store, operations: new Operations(configuration, transport, store) }
}

const sample = { action: 'sample' } as const
const early = { action: 'early-check', incident: { incident: 'operator-confirmed-result-1', reason: fixedHex(9) } } as const

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
