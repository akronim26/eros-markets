import { keccak256, recoverAddress, type Address, type Hex } from 'viem'
import { binding, equalHex, incidentId, observationDigest, type Envelope, type Incident, type Manifest, type Observation } from './schema'
import type { Pending, Store } from './store'
import { nextRollover, ROLLOVER_PAGE_SIZE, sameRolloverStep, type RolloverAction, type RolloverState } from './rollover'
import { measuredRolloverBatch } from './rollover-batch'

export type Snapshot = {
  block: bigint
  timestamp: bigint
  halted: boolean
  scheduledT: bigint
  monitor: Address
  monitorRestricted: boolean
  oracleState: number
  source: { id: Hex; signer: Address; rulesHash: Hex; configured: boolean; lastSequence: bigint; lastObservedAt: bigint }
  liquidation?: { participants: number; accountingState: number; capLots: bigint; remainingLots: bigint }
  rollover?: RolloverState
}

export type Call = {
  action: Pending['action']
  requestId: Hex
  target: Address
  functionName: 'samplePerp' | 'requestReduceOnly' | 'requestEarlyCheck' | 'submitObservation' | 'liquidate' | 'rollover' | RolloverAction
  args: readonly unknown[]
  gas: bigint
}

export interface Transport {
  snapshot(): Promise<Snapshot>
  digest(observation: Observation, block: bigint): Promise<Hex>
  simulate(call: Call): Promise<unknown>
  estimateGas?(call: Omit<Call, 'gas'>, block: bigint): Promise<bigint>
  prepare(call: Call): Promise<{ hash: Hex; rawTransaction: Hex }>
  broadcast(rawTransaction: Hex): Promise<Hex>
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; block: bigint; finalized: boolean } | null>
}

export type Command = { action: 'sample' } | { action: 'early-check'; incident: Incident } | { action: 'relay'; envelope: Envelope } | { action: 'liquidate' } | { action: 'rollover' }

export type Result = {
  outcome: 'sent' | 'pending' | 'finalized' | 'halted' | 'cadence' | 'complete' | 'obsolete' | 'planned' | 'no-work'
  action?: Pending['action']
  hash?: Hex
  rolloverBatch?: Pending['rolloverBatch']
}

function productiveLiquidation(raw: unknown): boolean {
  const result = raw as { mode: number; result: number; pairedLots: bigint; bookLots: bigint; reason: number }
  return result.reason === 0 && ((result.mode === 2 && result.result === 3) || result.bookLots > 0n || result.pairedLots > 0n)
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
    // Receipt reconciliation and the identity snapshot are independent reads.
    // Await both before journal changes or any rebroadcast, retaining identity
    // failure priority without adding another round trip to every sample.
    const [snapshotRead, receiptRead] = await Promise.allSettled([
      this.transport.snapshot(),
      journal.pending ? this.transport.receipt(journal.pending.hash) : Promise.resolve(null),
    ])
    if (snapshotRead.status === 'rejected') throw snapshotRead.reason
    if (receiptRead.status === 'rejected') throw receiptRead.reason
    const snapshot = snapshotRead.value
    if (journal.pending) {
      const pending = journal.pending
      const receipt = receiptRead.value
      if (!receipt?.finalized) {
        if (!receipt && broadcast) {
          const hash = await this.transport.broadcast(pending.rawTransaction)
          if (!equalHex(hash, pending.hash)) throw new Error('RPC returned a different transaction hash')
        }
        return { outcome: 'pending', action: pending.action, hash: pending.hash, ...(pending.rolloverBatch ? { rolloverBatch: pending.rolloverBatch } : {}) }
      }
      if (pending.action === 'sample' && receipt.status === 'success') journal.lastSampleBlock = receipt.block.toString()
      if (receipt.status === 'success' && (pending.action === 'early-check' || pending.action === 'relay')) {
        journal.completed.push(pending.requestId)
      }
      delete journal.pending
      this.store.write(journal)
      if (receipt.status === 'reverted') throw new Error(`Transaction reverted: ${pending.hash}; no next operation sent`)
      return { outcome: 'finalized', action: pending.action, hash: pending.hash, ...(pending.rolloverBatch ? { rolloverBatch: pending.rolloverBatch } : {}) }
    }

    let call: Omit<Call, 'gas'>
    let measuredGas: bigint | undefined
    let rolloverBatch: Pending['rolloverBatch']
    if (command.action === 'rollover') {
      if (!snapshot.rollover) throw new Error('Missing rollover snapshot')
      const functionName = nextRollover(snapshot.rollover)
      if (!functionName) return { outcome: snapshot.halted || snapshot.timestamp >= snapshot.scheduledT ? 'halted' : 'no-work' }
      call = { action: 'rollover', requestId: binding(this.manifest), target: this.manifest.engine,
        functionName, args: functionName === 'rollPage' ? [ROLLOVER_PAGE_SIZE] : [] }
      if (this.manifest.rolloverHelper) {
        const helper = this.manifest.rolloverHelper
        if (!this.transport.estimateGas) throw new Error('Batch rollover requires current gas estimation')
        const participants = snapshot.liquidation?.participants
        if (!Number.isInteger(participants) || participants! < 0 || participants! > 1024) throw new Error('Missing rollover participant count')
        const remaining = snapshot.rollover.work === 0 ? BigInt(participants!) : snapshot.rollover.count - snapshot.rollover.cursor
        const maximum = Math.min(helper.maxPages, Math.max(1, Number((remaining + 31n) / 32n)))
        const candidate = (pages: number): Omit<Call, 'gas'> => ({ action: 'rollover', requestId: binding(this.manifest),
          target: helper.address, functionName: 'rollover',
          args: [this.manifest.engine, snapshot.rollover!.epochId, snapshot.rollover!.work, snapshot.rollover!.cursor, pages] })
        const estimationStarted = performance.now()
        const chosen = await measuredRolloverBatch(maximum, BigInt(helper.gasCeiling),
          pages => this.transport.estimateGas!(candidate(pages), snapshot.block))
        call = candidate(chosen.pages)
        measuredGas = chosen.gas
        rolloverBatch = { pages: chosen.pages, estimatedGas: chosen.estimate.toString(), gasLimit: chosen.gas.toString(),
          estimateBlock: snapshot.block.toString(), estimationMs: Math.ceil(performance.now() - estimationStarted),
          ...(chosen.searchStop ? { searchStop: chosen.searchStop } : {}) }
      }
    } else if (command.action === 'liquidate') {
      if (snapshot.halted || snapshot.timestamp >= snapshot.scheduledT) return { outcome: 'halted' }
      const state = snapshot.liquidation
      if (!state || !Number.isInteger(state.participants) || state.participants < 0 || state.participants > 1024) throw new Error('Missing or invalid liquidation snapshot')
      if (state.accountingState !== 0 || state.capLots === 0n || state.remainingLots === 0n || state.participants === 0) return { outcome: 'no-work' }
      const limit = this.manifest.gas.liquidate
      if (limit === undefined) throw new Error('No measured gas limit for liquidate')
      let candidate: Call | undefined
      for (let examined = 0; examined < Math.min(32, state.participants); ++examined) {
        const trader = Math.min(journal.liquidationCursor ?? 1, state.participants)
        journal.liquidationCursor = trader === state.participants ? 1 : trader + 1
        const proposed: Call = { action: 'liquidate', requestId: binding(this.manifest), target: this.manifest.engine,
          functionName: 'liquidate', args: [trader, state.capLots, 8, 0], gas: BigInt(limit) }
        // eth_call executes the real touch/eligibility/coverage path. A stale account view
        // cannot hide accrued premium, and a no-liquidity result never burns a transaction.
        if (productiveLiquidation(await this.transport.simulate(proposed))) {
          candidate = proposed
          break
        }
      }
      if (broadcast) this.store.write(journal)
      if (!candidate) return { outcome: 'no-work' }
      call = candidate
    } else if (command.action === 'sample') {
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

    const limit = call.functionName === 'rollover' ? undefined : this.manifest.gas[call.functionName]
    if (measuredGas === undefined && limit === undefined) throw new Error(`No measured gas limit for ${call.functionName}`)
    const ready = { ...call, gas: measuredGas ?? BigInt(limit!) }
    const simulated = await this.transport.simulate(ready)
    if (call.action === 'liquidate' && !productiveLiquidation(simulated)) return { outcome: 'no-work' }
    if (call.action === 'rollover') {
      // A second worker may have advanced the page or finished the epoch while eth_call ran.
      // Recheck the pinned identity and exact step before signing; the next tick can re-plan.
      const fresh = await this.transport.snapshot()
      if (!fresh.rollover || !sameRolloverStep(snapshot.rollover!, fresh.rollover)) return { outcome: 'no-work' }
    }
    if (!broadcast) return { outcome: 'planned', action: call.action, ...(rolloverBatch ? { rolloverBatch } : {}) }
    const signed = await this.transport.prepare(ready)
    if (!equalHex(keccak256(signed.rawTransaction), signed.hash)) throw new Error('Prepared transaction hash mismatch')
    journal.pending = { ...signed, action: call.action, requestId: call.requestId, plannedBlock: snapshot.block.toString(), ...(rolloverBatch ? { rolloverBatch } : {}) }
    this.store.write(journal)
    const hash = await this.transport.broadcast(signed.rawTransaction)
    if (!equalHex(hash, signed.hash)) throw new Error('RPC returned a different transaction hash')
    return { outcome: 'sent', action: call.action, hash, ...(rolloverBatch ? { rolloverBatch } : {}) }
  }
}
