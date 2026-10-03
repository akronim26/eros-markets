// In-memory chain. A "bump" job (requestResolution) increments requestCount up to a cap, standing in for any
// state-changing call. Sends wait in a mempool until `mine()`, so tests control when they land.
import { type GasTable, loadGas } from '@eros-oracle/oracle-sdk'
import type { Hex } from 'viem'
import { keccak256, toHex } from 'viem'
import type { AssertionStatus, Chain, DisputeRecord, Job, MarketInfo, Planner, ReceiptStatus, Resolution, SettlementStatus, TreasuryState } from '../src/types'

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

export const ENGINE = '0x00000000000000000000000000000000000000ee' as Hex
export const INFO: MarketInfo = { tau: 1000n, hasFeed: true, bufferSecs: 60n, l1TimeoutSecs: 300n, l2DeadlineSecs: 600n, earlyTtlSecs: 600n, engine: ENGINE }

export const SETTLEMENT: SettlementStatus = {
  halted: true, finalOutcome: 2, invalidPriceReady: false, snapshotCursor: 0n, payoutCursor: 0n, accountCount: 64n,
  claimsEnabled: false, accountingComplete: false, recoveryRequired: false,
}

/** The real gas.json, so planners' gas keys are checked. */
export const GAS: GasTable = loadGas()

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
  info: MarketInfo = INFO
  infoReads = 0
  status: AssertionStatus = { exists: true, disputed: false, settled: false, truthful: false, expiresAt: 0n }
  ledger = 10_000_000_000n
  bond = 2_000_000n
  minInterval = 60n
  settlement: SettlementStatus = { ...SETTLEMENT }
  disputes = new Map<Hex, DisputeRecord>()
  treasury: TreasuryState = { usdcBalance: 1_000_000_000n, assertionLedger: 500_000_000n, watchdogFloat: 100_000_000n, totalCommitted: 400_000_000n, openDisputes: 0 }
  /** Function names whose simulation reverts. */
  revertFn = new Set<string>()
  /** Per-function simulate() results, overriding the bump logic. */
  simResult = new Map<string, unknown>()
  private nonce = 0

  constructor(ids: Hex[] = [id(1)]) {
    for (const m of ids) this.markets.set(m, resolution())
  }

  /** One keeper instance's view (its own `from`), sharing state and mempool. */
  as(from: string): Chain {
    return {
      now: () => this.now(),
      getResolution: (i) => this.getResolution(i),
      marketInfo: (i) => this.marketInfo(i),
      globalsMinRequestIntervalSecs: (v) => this.globalsMinRequestIntervalSecs(v),
      assertionStatus: (venue, a) => this.assertionStatus(venue, a),
      assertionLedger: () => this.assertionLedger(),
      bondFor: (i) => this.bondFor(i),
      settlementStatus: (e) => this.settlementStatus(e),
      treasuryDispute: (a) => this.treasuryDispute(a),
      treasuryState: () => this.treasuryState(),
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
  async marketInfo(_i: Hex) {
    this.infoReads++
    return this.info
  }
  async globalsMinRequestIntervalSecs(_v: number) {
    return this.minInterval
  }
  async assertionStatus(_venue: Hex, _a: Hex) {
    return this.status
  }
  async assertionLedger() {
    return this.ledger
  }
  async bondFor(_i: Hex) {
    return this.bond
  }
  async settlementStatus(_e: Hex) {
    return { ...this.settlement }
  }
  async treasuryDispute(a: Hex) {
    return this.disputes.get(a) ?? { marketId: ZERO32, venue: ZERO_ADDR, bond: 0n }
  }
  async treasuryState() {
    return { ...this.treasury }
  }
  async simulate(j: Job) {
    if (this.revertSim.has(j.marketId)) throw new Error('execution reverted: NotDue()')
    if (this.revertFn.has(j.functionName)) throw new Error(`execution reverted: ${j.functionName}`)
    if (this.simResult.has(j.functionName)) return this.simResult.get(j.functionName)
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
  /** A call that would change nothing succeeds as a no-op, as on the oracle. */
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
