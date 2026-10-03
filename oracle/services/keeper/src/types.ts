// Task O31.1: the keeper's moving parts (plan §9, §9.1). The core (keeper.ts) only knows these interfaces, so unit
// tests drive it with an in-memory chain and the jobs of O31.2/O31.3 plug in as planners.
import type { Hex } from 'viem'
import type { ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import type { ContractFunctionReturnType } from 'viem'

/** `getResolution`'s return value as viem decodes it. */
export type Resolution = ContractFunctionReturnType<typeof ResolutionOracleAbi, 'view', 'getResolution'>

/** The contracts a job may call, by their name in deployments/<network>.json. */
export type Target = 'ResolutionOracle' | 'KeeperRouter' | 'BondTreasury'

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
}

/** What a planner sees of one market: the state read this tick, its version and the chain's clock. */
export type MarketView = { id: Hex; resolution: Resolution; stateVersion: Hex; now: bigint }

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
