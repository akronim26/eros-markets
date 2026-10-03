// Task O31.1: the keeper's moving parts (plan §9, §9.1). The core (keeper.ts) only knows these interfaces, so unit
// tests drive it with an in-memory chain and the jobs of O31.2/O31.3 plug in as planners.
import type { GasTable, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import type { ContractFunctionReturnType, Hex } from 'viem'

/** `getResolution`'s return value as viem decodes it. */
export type Resolution = ContractFunctionReturnType<typeof ResolutionOracleAbi, 'view', 'getResolution'>

/** The contracts a job may call: by their name in deployments/<network>.json, or a market's engine (`address`). */
export type Target = 'ResolutionOracle' | 'KeeperRouter' | 'BondTreasury' | 'Engine'

/**
 * One transaction a planner wants sent. The key `(marketId, stateVersion, action)` identifies it: the keeper sends a
 * key at most once, and only while the market is still at `stateVersion`.
 */
export type Job = {
  marketId: Hex
  stateVersion: Hex
  action: string
  target: Target
  functionName: string
  args: readonly unknown[]
  /** The call's entry in deployments/gas.json; a job whose call has no measured limit is never sent. */
  gasKey: string
  /** From the simulated return value: true when sending would change nothing (default: the call returned false). */
  isNoop?: (result: unknown) => boolean
  /** Jobs with the same batch key that pass their checks in one tick are sent together (O31.2: finalizeMany). */
  batch?: Batch
  /** The engine's address, for target 'Engine'. */
  address?: Hex
  /**
   * For a job whose state is not the oracle's resolution (engine progress, a treasury dispute): reads the
   * current version, which must still equal `stateVersion` when the job is sent (O31.3).
   */
  freshVersion?: () => Promise<Hex>
}

export type Batch = {
  key: string
  max: number
  /** The one call that does the whole batch. */
  call(ids: Hex[]): Pick<Job, 'target' | 'functionName' | 'args'>
  /** Its gas limit for `k` markets, from gas.json; throws when gas.json has none (the batch is not sent). */
  gas(table: GasTable, k: number): bigint
}

/** What a market fixed at listing (registry): never changes, so the keeper reads it once. */
export type MarketInfo = {
  tau: bigint
  hasFeed: boolean
  bufferSecs: bigint // feed markets only (0 otherwise)
  l1TimeoutSecs: bigint // feed markets only (0 otherwise)
  l2DeadlineSecs: bigint
  earlyTtlSecs: bigint
  engine: Hex
}

export type AssertionStatus = { exists: boolean; disputed: boolean; settled: boolean; truthful: boolean; expiresAt: bigint }

/** Reads a planner may need beyond the resolution, made only when asked. */
export interface MarketReads {
  assertionStatus(): Promise<AssertionStatus>
  /** BondTreasury's ASSERTION ledger. */
  assertionLedger(): Promise<bigint>
  /** The bond `assertProposal` would post now. */
  bondFor(): Promise<bigint>
  /** `minRequestIntervalSecs` of the globals version the market pinned. */
  minRequestIntervalSecs(): Promise<bigint>
  /** The engine's `getSettlementStatus()`. */
  settlementStatus(): Promise<SettlementStatus>
}

/** The fields of the engine's SettlementView the keeper uses. */
export type SettlementStatus = {
  halted: boolean
  finalOutcome: number // engine numbering (engineAbi.ts EngineOutcome)
  invalidPriceReady: boolean
  snapshotCursor: bigint
  payoutCursor: bigint
  accountCount: bigint
  claimsEnabled: boolean
  accountingComplete: boolean
  recoveryRequired: boolean
}

/** BondTreasury's record of a dispute it funded (`venue` zero once closed or never recorded). */
export type DisputeRecord = { marketId: Hex; venue: Hex; bond: bigint }

/** Where the keeper learns the assertions BondTreasury has disputed (DisputeFunded). */
export interface DisputeSource {
  assertionIds(): Promise<Hex[]>
}

/** BondTreasury's balances and counters that the treasury jobs read. */
export type TreasuryState = {
  usdcBalance: bigint // USDC the treasury holds
  assertionLedger: bigint
  watchdogFloat: bigint
  totalCommitted: bigint
  openDisputes: number
}

/** What a global planner sees: every market read this tick, the chain's clock, reads and alerts. */
export type GlobalView = {
  now: bigint
  markets: MarketView[]
  reads: { treasury(): Promise<TreasuryState>; dispute(assertionId: Hex): Promise<DisputeRecord> }
  alert(msg: string, data?: Record<string, unknown>): void
}

/** Plans jobs that belong to no single market (treasury), or only checks and alerts. */
export type GlobalPlanner = (g: GlobalView) => Job[] | Promise<Job[]>

/** What a planner sees of one market: the state read this tick, its version, its listing and the chain's clock. */
export type MarketView = {
  id: Hex
  resolution: Resolution
  stateVersion: Hex
  now: bigint
  info: MarketInfo
  reads: MarketReads
  /** Pages a human (logged at error level with `alert: true`; the alerts service picks these up). */
  alert(msg: string, data?: Record<string, unknown>): void
}

/** Turns one market's state into the jobs that are due, most urgent first. */
export type Planner = (m: MarketView) => Job[] | Promise<Job[]>

/** Where the keeper learns which markets exist (the indexer, the registry's logs, or a fixed list). */
export interface MarketSource {
  marketIds(): Promise<Hex[]>
}

/** The chain as the keeper uses it; every read is at `latest` (§9: re-read before acting). */
export interface Chain {
  /** The latest block's timestamp. */
  now(): Promise<bigint>
  getResolution(id: Hex): Promise<Resolution>
  marketInfo(id: Hex): Promise<MarketInfo>
  globalsMinRequestIntervalSecs(version: number): Promise<bigint>
  assertionStatus(venue: Hex, assertionId: Hex): Promise<AssertionStatus>
  assertionLedger(): Promise<bigint>
  bondFor(id: Hex): Promise<bigint>
  settlementStatus(engine: Hex): Promise<SettlementStatus>
  treasuryDispute(assertionId: Hex): Promise<DisputeRecord>
  treasuryState(): Promise<TreasuryState>
  /** eth_call of the job from the keeper's account at `latest`; throws when it would revert. */
  simulate(job: Job): Promise<unknown>
  /** Signs and broadcasts with exactly `gas` as the limit; returns the hash without waiting for a receipt. */
  send(job: Job, gas: bigint): Promise<Hex>
  /** A sent transaction's fate so far. */
  receiptStatus(hash: Hex): Promise<ReceiptStatus>
}

export type ReceiptStatus = 'success' | 'reverted' | 'pending'

export type Outcome =
  | 'sent' // broadcast
  | 'duplicate' // this key was already sent (or is being sent) by this instance
  | 'stale' // the market moved on between planning and sending
  | 'noop' // the simulated call would change nothing
  | 'reverts' // the simulated call reverts
  | 'no-gas-limit' // gas.json has no limit for the call
  | 'failed' // the read, simulation or broadcast failed for another reason (retried next tick)

export type JobResult = { key: string; job: Job; outcome: Outcome; hash?: Hex; error?: string }

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
