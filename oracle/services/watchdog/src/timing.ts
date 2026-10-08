export const DISPUTE_MARGIN_SECS = 600n
export const MIN_TESTNET_DISPUTE_MARGIN_SECS = 30n
export type Liveness = { livenessL1: bigint; livenessAuto: bigint; livenessReviewed: bigint }

/** An explicit testnet override; the actual RPC chain is checked before a service can send. */
export function disputeMargin(values: { network: string; deploymentChainId: number; rpcChainId: number; testnetMargin?: string }): bigint {
  if (values.deploymentChainId !== values.rpcChainId) throw new Error('WATCHDOG_RPC_CHAIN_MISMATCH')
  if (values.testnetMargin === undefined) return DISPUTE_MARGIN_SECS
  if (values.network !== 'monad-testnet' || values.deploymentChainId !== 10143 || values.rpcChainId !== 10143) {
    throw new Error('SHORT_DISPUTE_MARGIN_REQUIRES_MONAD_TESTNET')
  }
  if (!/^[1-9][0-9]*$/.test(values.testnetMargin)) throw new Error('INVALID_TESTNET_DISPUTE_MARGIN')
  const margin = BigInt(values.testnetMargin)
  if (margin < MIN_TESTNET_DISPUTE_MARGIN_SECS || margin >= DISPUTE_MARGIN_SECS) throw new Error('TESTNET_DISPUTE_MARGIN_MUST_BE_30_TO_599_SECONDS')
  return margin
}

export function assertLiveness(liveness: Liveness, margin: bigint): void {
  for (const [path, seconds] of Object.entries(liveness)) {
    if (seconds <= margin) throw new Error(`WATCHDOG_LIVENESS_INCOMPATIBLE: ${path}=${seconds}s must exceed dispute margin ${margin}s`)
  }
}
