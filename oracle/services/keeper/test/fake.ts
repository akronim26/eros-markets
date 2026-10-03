// An in-memory chain for the keeper's unit tests. Each market has a Resolution; a "bump" job (requestResolution)
// increments requestCount up to a cap, as a stand-in for any state-changing call. Sent transactions sit in a
// mempool until `mine()`, so tests control when a send becomes visible (Monad executes asynchronously).
import type { GasTable } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { keccak256, toHex } from 'viem'
import type { Chain, Job, Planner, ReceiptStatus, Resolution } from '../src/types'

export const ZERO32 = `0x${'00'.repeat(32)}` as Hex
export const ZERO_ADDR = `0x${'00'.repeat(20)}` as Hex
export const id = (n: number) => keccak256(toHex(`market-${n}`))

export function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    state: 3,
    proposed: 0,
    path: 0,
    attempts: 0,
    rejectedMask: 0,
    outcome: 0,
    finalReason: 0,
    voided: false,
    haltedAt: 1000n,
    voidDeadline: 2000n,
    l2StartedAt: 0n,
    retryOpensAt: 0n,
    earlyStartedAt: 0n,
    lastRequestAt: 0n,
    requestCount: 0,
    trustSetId: 1,
    globalsVersion: 1,
    oiHaltLots: 0n,
    evidenceHash: ZERO32,
    valueHash: ZERO32,
    assertionId: ZERO32,
    assertionVenue: ZERO_ADDR,
    bond: 0n,
    proposer: ZERO_ADDR,
    rewardAtoms: 0n,
    ...over,
  }
}

export const GAS: GasTable = { calls: { requestResolution: { limit: 120000 } } }

/** Plans one bump while requestCount is below `cap`. */
export const bumpPlanner = (cap = 1, gasKey = 'requestResolution'): Planner => (m) =>
  m.resolution.requestCount < cap
    ? [{ marketId: m.id, stateVersion: m.stateVersion, action: 'request', target: 'ResolutionOracle', functionName: 'requestResolution', args: [m.id], gasKey }]
    : []

type Tx = { hash: Hex; job: Job; gas: bigint; from: string }

export class FakeChain implements Chain {
  readonly markets = new Map<Hex, Resolution>()
  readonly mempool: Tx[] = []
  readonly sends: Tx[] = []
  readonly receipts = new Map<Hex, ReceiptStatus>()
  cap = 1
  time = 5000n
  revertSim = new Set<Hex>()
  failSend = 0 // the next n sends throw
  failRead = new Set<Hex>()
  private nonce = 0

  constructor(ids: Hex[] = [id(1)]) {
    for (const m of ids) this.markets.set(m, resolution())
  }

  /** A view of the chain as one keeper instance sees it (its own `from`), sharing state and mempool. */
  as(from: string): Chain {
    return {
      now: () => this.now(),
      getResolution: (i) => this.getResolution(i),
      simulate: (j) => this.simulate(j),
      send: (j, g) => this.sendFrom(from, j, g),
      receiptStatus: (h) => this.receiptStatus(h),
    }
  }

  async now() {
    return this.time
  }
  async getResolution(i: Hex) {
    if (this.failRead.has(i)) throw new Error('rpc: read failed')
    const r = this.markets.get(i)
    if (!r) throw new Error(`no market ${i}`)
    return { ...r }
  }
  async simulate(j: Job) {
    if (this.revertSim.has(j.marketId)) throw new Error('execution reverted: NotDue()')
    return this.markets.get(j.marketId)!.requestCount < this.cap // false = nothing would change
  }
  send(j: Job, gas: bigint) {
    return this.sendFrom('keeper', j, gas)
  }
  async sendFrom(from: string, job: Job, gas: bigint) {
    if (this.failSend > 0) {
      this.failSend--
      throw new Error('rpc: broadcast failed')
    }
    const tx = { hash: keccak256(toHex(`tx-${this.nonce++}`)), job, gas, from }
    this.mempool.push(tx)
    this.sends.push(tx)
    return tx.hash
  }
  async receiptStatus(h: Hex) {
    return this.receipts.get(h) ?? 'pending'
  }
  /** Executes the mempool in order; a call that would change nothing succeeds as a no-op, like the oracle's. */
  mine(revert = false) {
    for (const tx of this.mempool.splice(0)) {
      if (revert) {
        this.receipts.set(tx.hash, 'reverted')
        continue
      }
      const r = this.markets.get(tx.job.marketId)!
      if (r.requestCount < this.cap) this.markets.set(tx.job.marketId, { ...r, requestCount: r.requestCount + 1, lastRequestAt: this.time })
      this.receipts.set(tx.hash, 'success')
    }
  }
}
