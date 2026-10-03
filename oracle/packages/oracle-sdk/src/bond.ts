// Mirrors of BondMath.sol and VoidBound.sol, so services compute what the contracts will.

export const ATOMS_PER_LOT = 1000n // 1 lot = 0.001 claim; a claim pays 1e6 USDC atoms at YES
export const BPS = 10_000n
export const A_MAX = 3n

/** Path enum (OracleTypes.sol); values are ABI. */
export const Path = { NONE: 0, L1: 1, L2_AUTO: 2, REVIEWED: 3, PERMISSIONLESS: 4 } as const

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n)
const max = (...xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m))

function nonNegative(name: string, x: bigint) {
  if (x < 0n) throw new RangeError(`${name} is negative`)
}

/** `max(minBond, venueMinimumBond, ceil(oiLots × 1000 × bondBps / 10 000))`, in USDC atoms. */
export function bond(oiLots: bigint, minBond: bigint, bondBps: number | bigint, venueMinimumBond: bigint): bigint {
  const bps = BigInt(bondBps)
  for (const [n, x] of [['oiLots', oiLots], ['minBond', minBond], ['bondBps', bps], ['venueMinimumBond', venueMinimumBond]] as const) {
    nonNegative(n, x)
  }
  if (bps >= 1n << 16n) throw new RangeError('bondBps exceeds uint16')
  return max(ceilDiv(oiLots * ATOMS_PER_LOT * bps, BPS), minBond, venueMinimumBond)
}

/** Fresh: not revoked, and the last heartbeat is set, not in the future and at most `heartbeatMaxAgeSecs` old. */
export function isWatchdogFresh(now: bigint, lastHeartbeat: bigint, heartbeatMaxAgeSecs: bigint, revoked: boolean): boolean {
  if (revoked || lastHeartbeat === 0n || lastHeartbeat > now) return false
  return now - lastHeartbeat <= heartbeatMaxAgeSecs
}

export type Liveness = { livenessL1: bigint; livenessAuto: bigint; livenessReviewed: bigint }

/** L1 and L2_AUTO get their own liveness only while the watchdog is fresh; otherwise reviewed liveness. */
export function liveness(path: number, uma: Liveness, watchdogFresh: boolean): bigint {
  if (path === Path.NONE) throw new Error('NoPath')
  if (path === Path.L1 && watchdogFresh) return uma.livenessL1
  if (path === Path.L2_AUTO && watchdogFresh) return uma.livenessAuto
  return uma.livenessReviewed
}

export type VoidBoundInputs = {
  hasFeed: boolean
  l1TimeoutSecs: bigint // T_L1, ignored without a feed
  l2DeadlineSecs: bigint // T_L2
  livenessReviewed: bigint // T_live
  dvmMaxRolls: bigint // R_max
  dvmRoundSecs: bigint // T_round
  reviewTargetSecs: bigint // T_r
  retryWindowSecs: bigint // T_retry
  voidSlackSecs: bigint // T_slack
}

/** `T_L1 + T_L2 + A_max·(T_live + (R_max + 2)·T_round) + (A_max − 1)·(T_r + T_retry) + T_slack`. */
export function minVoidSecs(i: VoidBoundInputs): bigint {
  for (const [n, x] of Object.entries(i)) if (typeof x === 'bigint') nonNegative(n, x)
  const tL1 = i.hasFeed ? i.l1TimeoutSecs : 0n
  const perAttempt = i.livenessReviewed + (i.dvmMaxRolls + 2n) * i.dvmRoundSecs
  const perRetry = i.reviewTargetSecs + i.retryWindowSecs
  return tL1 + i.l2DeadlineSecs + A_MAX * perAttempt + (A_MAX - 1n) * perRetry + i.voidSlackSecs
}
