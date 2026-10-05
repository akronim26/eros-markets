import { keccak256, recoverAddress, type Address, type Hex } from 'viem'
import { binding, equalHex, incidentId, observationDigest, type Envelope, type Incident, type Manifest, type Observation } from './schema'
import type { Pending, Store } from './store'

export type Snapshot = {
  block: bigint
  timestamp: bigint
  halted: boolean
  scheduledT: bigint
  monitor: Address
  monitorRestricted: boolean
  oracleState: number
  source: { id: Hex; signer: Address; rulesHash: Hex; configured: boolean; lastSequence: bigint; lastObservedAt: bigint }
}

export type Call = {
  action: Pending['action']
  requestId: Hex
  target: Address
  functionName: 'samplePerp' | 'requestReduceOnly' | 'requestEarlyCheck' | 'submitObservation'
  args: readonly unknown[]
  gas: bigint
}

export interface Transport {
  snapshot(): Promise<Snapshot>
  digest(observation: Observation, block: bigint): Promise<Hex>
  simulate(call: Call): Promise<unknown>
  prepare(call: Call): Promise<{ hash: Hex; rawTransaction: Hex }>
  broadcast(rawTransaction: Hex): Promise<Hex>
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; block: bigint; finalized: boolean } | null>
}

export type Command = { action: 'sample' } | { action: 'early-check'; incident: Incident } | { action: 'relay'; envelope: Envelope }

export type Result = {
  outcome: 'sent' | 'pending' | 'finalized' | 'halted' | 'cadence' | 'complete' | 'obsolete' | 'planned'
  action?: Pending['action']
  hash?: Hex
}

export class Operations {
  private busy = false

  constructor(private readonly manifest: Manifest, private readonly transport: Transport, private readonly store: Store) {}

  async tick(command: Command, broadcast = false): Promise<Result> {
    if (this.busy) throw new Error('An operation is already in flight')
    this.busy = true
    try {
      return await this.run(command, broadcast)
    } finally {
      this.busy = false
    }
  }

  private async run(command: Command, broadcast: boolean): Promise<Result> {
    const journal = this.store.read()
    if (!equalHex(journal.binding, binding(this.manifest))) throw new Error('Journal binding mismatch')
    const snapshot = await this.transport.snapshot()
    if (journal.pending) {
      const pending = journal.pending
      const receipt = await this.transport.receipt(pending.hash)
      if (!receipt?.finalized) {
        if (!receipt && broadcast) {
          const hash = await this.transport.broadcast(pending.rawTransaction)
          if (!equalHex(hash, pending.hash)) throw new Error('RPC returned a different transaction hash')
        }
        return { outcome: 'pending', action: pending.action, hash: pending.hash }
      }
      if (pending.action === 'sample') journal.lastSampleBlock = receipt.block.toString()
      if (receipt.status === 'success' && (pending.action === 'early-check' || pending.action === 'relay')) {
        journal.completed.push(pending.requestId)
      }
      delete journal.pending
      this.store.write(journal)
      if (receipt.status === 'reverted') throw new Error(`Transaction reverted: ${pending.hash}; no next operation sent`)
      return { outcome: 'finalized', action: pending.action, hash: pending.hash }
    }

    let call: Omit<Call, 'gas'>
    if (command.action === 'sample') {
      if (snapshot.halted || snapshot.timestamp >= snapshot.scheduledT) return { outcome: 'halted' }
      if (journal.lastSampleBlock !== undefined && snapshot.block < BigInt(journal.lastSampleBlock) + this.manifest.sampleEveryBlocks) {
        return { outcome: 'cadence' }
      }
      call = { action: 'sample', requestId: binding(this.manifest), target: this.manifest.engine, functionName: 'samplePerp', args: [] }
    } else if (command.action === 'early-check') {
      const requestId = incidentId(command.incident)
      if (journal.completed.some(value => equalHex(value, requestId))) return { outcome: 'complete' }
      if (!equalHex(snapshot.monitor, this.manifest.sender)) throw new Error('Sender is not listing.monitor')
      if (snapshot.halted || snapshot.timestamp >= snapshot.scheduledT) throw new Error('Early check requires a live market before T')
      if (snapshot.oracleState !== 0) throw new Error('Early check requires oracle state None')
      call = snapshot.monitorRestricted
        ? { action: 'early-check', requestId, target: this.manifest.oracle, functionName: 'requestEarlyCheck', args: [this.manifest.marketId] }
        : { action: 'restrict', requestId, target: this.manifest.engine, functionName: 'requestReduceOnly', args: [command.incident.reason] }
    } else {
      const envelope = command.envelope
      const observation = envelope.observation
      const source = snapshot.source
      if (envelope.chainId !== this.manifest.chainId || !equalHex(envelope.engine, this.manifest.engine)) throw new Error('Observation has wrong chain or engine')
      if (!equalHex(observation.marketId, this.manifest.marketId)) throw new Error('Observation has wrong market')
      if (!source.configured || !equalHex(observation.sourceId, source.id) || !equalHex(observation.sourceRulesHash, source.rulesHash)) throw new Error('Observation source or rules mismatch')
      if (observation.sequence <= source.lastSequence) return { outcome: 'obsolete' }
      if (observation.observedAt < source.lastObservedAt) throw new Error('Observation time moves backwards')
      if (observation.observedAt > observation.publishedAt || observation.publishedAt > snapshot.timestamp) throw new Error('Observation timestamp order invalid')
      const digest = observationDigest(envelope)
      if (!equalHex(await this.transport.digest(observation, snapshot.block), digest)) throw new Error('Onchain observation digest mismatch')
      if (!equalHex(await recoverAddress({ hash: digest, signature: envelope.signature }), source.signer)) throw new Error('Observation signer mismatch')
      call = { action: 'relay', requestId: digest, target: this.manifest.engine, functionName: 'submitObservation', args: [observation, envelope.signature] }
    }

    const limit = this.manifest.gas[call.functionName]
    if (limit === undefined) throw new Error(`No measured gas limit for ${call.functionName}`)
    const ready = { ...call, gas: BigInt(limit) }
    await this.transport.simulate(ready)
    if (!broadcast) return { outcome: 'planned', action: call.action }
    const signed = await this.transport.prepare(ready)
    if (!equalHex(keccak256(signed.rawTransaction), signed.hash)) throw new Error('Prepared transaction hash mismatch')
    journal.pending = { ...signed, action: call.action, requestId: call.requestId, plannedBlock: snapshot.block.toString() }
    this.store.write(journal)
    const hash = await this.transport.broadcast(signed.rawTransaction)
    if (!equalHex(hash, signed.hash)) throw new Error('RPC returned a different transaction hash')
    return { outcome: 'sent', action: call.action, hash }
  }
}
