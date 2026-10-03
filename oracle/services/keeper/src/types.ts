// The keeper core only knows these interfaces, so tests can drive it with an in-memory chain.
import type { GasTable, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import type { ContractFunctionReturnType, Hex } from 'viem'

/** `getResolution`'s return value as viem decodes it. */
export type Resolution = ContractFunctionReturnType<typeof ResolutionOracleAbi, 'view', 'getResolution'>

/** A contract named in deployments/<network>.json, or a market's engine (`address`). */
export type Target = 'ResolutionOracle' | 'KeeperRouter' | 'BondTreasury' | 'Engine'

/** Sent at most once per `(marketId, stateVersion, action)`, and only while the market is still at `stateVersion`. */
export type Job = {
  marketId: Hex
  stateVersion: Hex
  action: string
  target: Target
  functionName: string
  args: readonly unknown[]
  /** The call's deployments/gas.json entry; a job without one is never sent. */
  gasKey: string
  /** True when the simulated result means nothing would change (default: the call returned false). */
  isNoop?: (result: unknown) => boolean
  /** Jobs with the same batch key that pass their checks in one tick are sent as one call. */
  batch?: Batch
  /** For target 'Engine'. */
  address?: Hex
  /** For a job whose state is not the market's resolution: the current version, which must still be `stateVersion`. */
  freshVersion?: () => Promise<Hex>
}

export type Batch = {
  key: string
  max: number
  /** The one call that does the whole batch. */
  call(ids: Hex[]): Pick<Job, 'target' | 'functionName' | 'args'>
  /** Gas limit for `k` markets; throws when gas.json has none. */
  gas(table: GasTable, k: number): bigint
}

/** Fixed at listing, so read once. */
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

/** Lazy reads beyond the resolution. */
export interface MarketReads {
  assertionStatus(): Promise<AssertionStatus>
  assertionLedger(): Promise<bigint>
  /** The bond `assertProposal` would post now. */
  bondFor(): Promise<bigint>
  /** From the globals version the market pinned. */
  minRequestIntervalSecs(): Promise<bigint>
  settlementStatus(): Promise<SettlementStatus>
}

export type SettlementStatus = {
  halted: boolean
  finalOutcome: number // EngineOutcome numbering
  invalidPriceReady: boolean
  snapshotCursor: bigint
  payoutCursor: bigint
  accountCount: bigint
  claimsEnabled: boolean
  accountingComplete: boolean
  recoveryRequired: boolean
}

/** `venue` is zero once closed or if never recorded. */
export type DisputeRecord = { marketId: Hex; venue: Hex; bond: bigint }

export interface DisputeSource {
  assertionIds(): Promise<Hex[]>
}

export type TreasuryState = {
  usdcBalance: bigint
  assertionLedger: bigint
  watchdogFloat: bigint
  totalCommitted: bigint
  openDisputes: number
}

export type GlobalView = {
  now: bigint
  markets: MarketView[]
  reads: { treasury(): Promise<TreasuryState>; dispute(assertionId: Hex): Promise<DisputeRecord> }
  alert(msg: string, data?: Record<string, unknown>): void
}

/** Plans jobs that belong to no single market, or only checks and alerts. */
export type GlobalPlanner = (g: GlobalView) => Job[] | Promise<Job[]>

export type MarketView = {
  id: Hex
  resolution: Resolution
  stateVersion: Hex
  now: bigint
  info: MarketInfo
  reads: MarketReads
  /** Logged at error level with `alert: true`, for paging. */
  alert(msg: string, data?: Record<string, unknown>): void
}

/** Returns the market's due jobs, most urgent first. */
export type Planner = (m: MarketView) => Job[] | Promise<Job[]>

export interface MarketSource {
  marketIds(): Promise<Hex[]>
}

/** Every read is at `latest`. */
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
  /** eth_call from the keeper's account; throws when it would revert. */
  simulate(job: Job): Promise<unknown>
  /** Broadcasts with exactly `gas` as the limit; does not wait for a receipt. */
  send(job: Job, gas: bigint): Promise<Hex>
  receiptStatus(hash: Hex): Promise<ReceiptStatus>
}

export type ReceiptStatus = 'success' | 'reverted' | 'pending'

export type Outcome =
  | 'sent'
  | 'duplicate' // this instance already sent (or is sending) the key
  | 'stale' // the market moved on between planning and sending
  | 'noop' // the simulated call would change nothing
  | 'reverts' // the simulated call reverts
  | 'no-gas-limit' // gas.json has no limit for the call
  | 'failed' // any other read, simulation or broadcast failure; retried next tick

export type JobResult = { key: string; job: Job; outcome: Outcome; hash?: Hex; error?: string }

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
