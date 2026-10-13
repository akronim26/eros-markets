import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORACLE_ROOT } from '../src/abi/sources'
import { Path, bond, isWatchdogFresh, liveness, minVoidSecs } from '../src/bond'

const read = (f: string) => JSON.parse(readFileSync(join(ORACLE_ROOT, 'vectors', f), 'utf8'))

describe('bond', () => {
  test('every vector in bond.json', () => {
    const B = read('bond.json')
    expect(B.vectors.length).toBeGreaterThan(0)
    for (const v of B.vectors) {
      expect(bond(BigInt(v.oiHaltLots), BigInt(v.minBond), v.bondBps, BigInt(v.venueMinimumBond)), v.name).toBe(BigInt(v.expectedAtoms))
    }
  })

  test('the proportional term rounds up; either floor wins when larger', () => {
    expect(bond(1n, 0n, 1, 0n)).toBe(1n) // 1000 × 1 / 10000 = 0.1 → 1
    expect(bond(10n, 0n, 1, 0n)).toBe(1n) // exactly 1
    expect(bond(11n, 0n, 1, 0n)).toBe(2n) // 1.1 → 2
    expect(bond(0n, 0n, 1112, 0n)).toBe(0n)
    expect(bond(2_000_000n, 300_000_000n, 1112, 2_000_000n)).toBe(300_000_000n)
    expect(bond(2_000_000n, 2_000_000n, 1112, 500_000_000n)).toBe(500_000_000n)
  })

  test('out-of-range inputs are refused, not wrapped', () => {
    expect(() => bond(-1n, 0n, 1, 0n)).toThrow(RangeError)
    expect(() => bond(1n, 0n, 65536, 0n)).toThrow(/uint16/)
  })
})

describe('liveness and watchdog', () => {
  const uma = { livenessL1: 7200n, livenessAuto: 14400n, livenessReviewed: 86400n }

  test('fresh watchdog: L1 and L2_AUTO use their own; stale: reviewed', () => {
    expect(liveness(Path.L1, uma, true)).toBe(7200n)
    expect(liveness(Path.L2_AUTO, uma, true)).toBe(14400n)
    expect(liveness(Path.L1, uma, false)).toBe(86400n)
    expect(liveness(Path.L2_AUTO, uma, false)).toBe(86400n)
    expect(liveness(Path.REVIEWED, uma, true)).toBe(86400n)
    expect(liveness(Path.PERMISSIONLESS, uma, true)).toBe(86400n)
    expect(() => liveness(Path.NONE, uma, true)).toThrow(/NoPath/)
  })

  test('freshness: never-sent, future, revoked and the age boundary', () => {
    expect(isWatchdogFresh(1000n, 0n, 600n, false)).toBe(false)
    expect(isWatchdogFresh(1000n, 1001n, 600n, false)).toBe(false)
    expect(isWatchdogFresh(1000n, 900n, 600n, true)).toBe(false)
    expect(isWatchdogFresh(1000n, 400n, 600n, false)).toBe(true)
    expect(isWatchdogFresh(1000n, 399n, 600n, false)).toBe(false)
  })
})

describe('void bound', () => {
  const V = read('voidbound.json')
  const inputs = (v: any, hasFeed = true) => ({
    hasFeed,
    l1TimeoutSecs: BigInt(v.tL1),
    l2DeadlineSecs: BigInt(v.tL2),
    livenessReviewed: BigInt(v.tLive),
    dvmMaxRolls: BigInt(v.rMax),
    dvmRoundSecs: BigInt(v.tRound),
    reviewTargetSecs: BigInt(v.tR),
    retryWindowSecs: BigInt(v.tRetry),
    voidSlackSecs: BigInt(v.tSlack),
  })

  test('production and testnet vectors', () => {
    for (const name of ['production', 'testnet']) {
      const v = V[name]
      expect(BigInt(v.aMax)).toBe(3n)
      expect(minVoidSecs(inputs(v)), name).toBe(BigInt(v.expectedSecs))
    }
  })

  test('without a feed T_L1 drops out', () => {
    const v = V.production
    expect(minVoidSecs(inputs(v, false))).toBe(BigInt(v.expectedSecs) - BigInt(v.tL1))
  })
})
