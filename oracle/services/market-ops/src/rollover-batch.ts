import { keccak256, parseAbi, type Address, type Hex } from 'viem'

export const RolloverBatcherAbi = parseAbi([
  'function rollover(address engine,uint64 expectedEpoch,uint8 expectedWork,uint256 expectedCursor,uint8 maxPages) returns (uint8 pages,bool completed)',
  'event RolloverAdvanced(address indexed engine,uint64 indexed epoch,uint256 cursor,uint256 count,uint8 pages,bool completed)',
])

/** Only a positively identified gas ceiling failure permits a smaller candidate. */
export class BatchGasLimitExceeded extends Error {}
/** An opaque provider revert is not evidence of out-of-gas. */
export class BatchEstimateOpaqueRevert extends Error {}

export function isOpaqueBatchEstimateRevert(error: unknown): boolean {
  const seen = new Set<unknown>()
  let item = error, matched = false
  for (let depth = 0; item && typeof item === 'object' && depth < 16; depth++) {
    if (seen.has(item)) return false
    seen.add(item)
    const value = item as { code?: unknown; data?: unknown; raw?: unknown; cause?: unknown }
    if ((value.data !== undefined && value.data !== '0x') || (value.raw !== undefined && value.raw !== '0x')) return false
    const exact = value.code === 3 && value.data === '0x'
    if (matched && !exact) return false
    if (exact) matched = true
    item = value.cause
  }
  return matched && !item
}

export function isBatchGasLimitError(error: unknown): boolean {
  return /out of gas|gas required exceeds allowance|exceeds (?:the )?block gas limit|transaction gas limit exceeded/i.test(String(error))
}

export async function verifyRolloverHelper(helper: { address: Address; codeHash: Hex } | undefined,
  blockNumber: bigint, readCode: (address: Address, blockNumber: bigint) => Promise<Hex | undefined>): Promise<void> {
  if (!helper) return
  const code = await readCode(helper.address, blockNumber)
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== helper.codeHash.toLowerCase()) {
    throw new Error('Rollover helper runtime hash mismatch')
  }
}

export function rolloverBatchGas(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error('Invalid rollover batch gas estimate')
  return (estimate * 120n + 99n) / 100n + 10_000n
}

/** At most six current-state estimates for the protocol's 32-page bound. */
export async function measuredRolloverBatch(maxPages: number, gasCeiling: bigint,
  estimate: (pages: number) => Promise<bigint>): Promise<{ pages: number; gas: bigint; estimate: bigint; searchStop?: { pages: number; reason: 'opaque-empty-revert' } }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 32
    || gasCeiling <= 0n || gasCeiling > 30_000_000n) throw new Error('Invalid rollover batch bounds')
  let lower = 1, upper = maxPages, best: { pages: number; gas: bigint; estimate: bigint } | undefined
  while (lower <= upper) {
    const pages = Math.floor((lower + upper) / 2)
    let gas: bigint, measured: bigint
    try { measured = await estimate(pages); gas = rolloverBatchGas(measured) }
    catch (error) {
      // A previously measured fitting prefix is safe to simulate exactly. Do not
      // infer why the larger candidate failed or use it as a gas-search bound.
      if (error instanceof BatchEstimateOpaqueRevert && best && pages > best.pages) return { ...best, searchStop: { pages, reason: 'opaque-empty-revert' } }
      if (!(error instanceof BatchGasLimitExceeded)) throw error
      upper = pages - 1
      continue
    }
    if (gas <= gasCeiling) { best = { pages, gas, estimate: measured }; lower = pages + 1 }
    else upper = pages - 1
  }
  if (!best) throw new Error('No measured rollover batch fits the gas ceiling')
  return best
}
