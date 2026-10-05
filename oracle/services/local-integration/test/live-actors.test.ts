import { describe, expect, test } from 'bun:test'
import { bootstrapRolloverGate, ceilAtoms, isPostTradeSample, isSamplingPauseAcknowledged, liveCollateralAtoms, quoteTicks } from '../src/live-actors'

describe('real-source owner collateral', () => {
  const q = 10n ** 18n
  const preview = { requiredImQ: 10_000000n * q, feeCapQ: 123n * q + 1n }
  test('rounds even a one-Q fee remainder up to a spendable token atom', () => {
    expect(ceilAtoms(1n)).toBe(1n)
    expect(ceilAtoms(q)).toBe(1n)
    expect(ceilAtoms(q + 1n)).toBe(2n)
    expect(() => ceilAtoms(-1n)).toThrow('NEGATIVE_COLLATERAL')
  })
  test('funds adverse execution for each direction without spending favorable PnL', () => {
    const base = 10_010124n
    expect(liveCollateralAtoms(preview, true, 500n * 10n ** 15n, 500, 100_000n)).toBe(base)
    expect(liveCollateralAtoms(preview, true, 500n * 10n ** 15n, 501, 100_000n)).toBe(base + 100000n)
    expect(liveCollateralAtoms(preview, false, 500n * 10n ** 15n, 499, 100_000n)).toBe(base + 100000n)
    expect(liveCollateralAtoms(preview, true, 500n * 10n ** 15n, 499, 100_000n)).toBe(base)
    expect(liveCollateralAtoms(preview, false, 500n * 10n ** 15n, 501, 100_000n)).toBe(base)
  })
  test('rejects impossible ticks, negative fees and nonpositive position sizes', () => {
    for (const tick of [0, 1000, 500.5]) expect(() => liveCollateralAtoms(preview, true, q / 2n, tick, 1n)).toThrow()
    expect(() => liveCollateralAtoms({ ...preview, feeCapQ: -1n }, true, q / 2n, 500, 1n)).toThrow()
    expect(() => liveCollateralAtoms(preview, true, q / 2n, 500, 0n)).toThrow()
  })
  test('quotes stay inside the valid book range and leave room for a matched trade', () => {
    expect(quoteTicks(105n * 10n ** 15n, 50n * 10n ** 15n)).toEqual([100, 110])
    for (const price of [1n, 999n * 10n ** 15n]) expect(() => quoteTicks(price, q / 20n)).toThrow('TOO_CLOSE_TO_ENDPOINT')
    expect(() => quoteTicks(q / 2n, 1n)).toThrow('QUOTE_RANGE_INVALID')
  })
})

describe('real-source trade completion', () => {
  const trade = { blockNumber: '100', timestamp: '1800000100' }
  test('waits for a valid observation captured after the trade, not merely a later receipt', () => {
    expect(isPostTradeSample({ blockNumber: '102', observation: { valid: true, t: '1800000099' } }, trade)).toBe(false)
    expect(isPostTradeSample({ blockNumber: '102', observation: { valid: false, t: '1800000101' } }, trade)).toBe(false)
    expect(isPostTradeSample({ blockNumber: '100', observation: { valid: true, t: '1800000101' } }, trade)).toBe(false)
    expect(isPostTradeSample({ blockNumber: 102n, observation: { valid: true, t: 1800000100n } }, trade)).toBe(true)
    expect(isPostTradeSample({ blockNumber: '103', observation: { valid: true, t: '1800000110' } }, trade)).toBe(true)
  })
  test('incomplete or malformed publisher reports cannot complete the proof', () => {
    for (const sample of [null, {}, { blockNumber: 102 }, { blockNumber: 'bad', observation: { valid: true, t: '1800000101' } },
      { blockNumber: 102, observation: { valid: true } }, { blockNumber: 102, observation: { valid: true, t: true } }]) {
      expect(isPostTradeSample(sample, trade)).toBe(false)
    }
  })
})

test('a stale or undrained pause acknowledgement cannot authorize actor mutations', () => {
  const current = 'current-request'
  expect(isSamplingPauseAcknowledged({ samplingPaused: true, samplingPauseRequestId: 'previous-request' }, current)).toBe(false)
  expect(isSamplingPauseAcknowledged({ samplingPaused: false, samplingPauseRequestId: current }, current)).toBe(false)
  expect(isSamplingPauseAcknowledged({ samplingPaused: true }, current)).toBe(false)
  expect(isSamplingPauseAcknowledged(null, current)).toBe(false)
  expect(isSamplingPauseAcknowledged({ samplingPaused: true, samplingPauseRequestId: '' }, '')).toBe(false)
  expect(isSamplingPauseAcknowledged({ samplingPaused: true, samplingPauseRequestId: current }, current)).toBe(true)
})

describe('bootstrap rollover sealed sample deadline', () => {
  const state = { timestamp: 3980n, epochEnd: 4000n, pricingMode: 0, work: 0, pending: false, establishedLiquidity: true }
  const sealed = (t: string, valid = true) => ({ observation: { t, valid } })
  test('waits proactively for a seal whose capture can survive the boundary', () => {
    expect(bootstrapRolloverGate(state, sealed('3980'))).toBe('wait-for-seal')
    expect(bootstrapRolloverGate({ ...state, timestamp: 3999n }, sealed('3985'))).toBe('pause-for-boundary')
    expect(bootstrapRolloverGate({ ...state, timestamp: 4000n }, sealed('3985'))).toBe('pause-for-boundary')
  })
  test('a stale rollover prerequisite expires instead of waiting for impossible post-epoch depth', () => {
    expect(bootstrapRolloverGate({ ...state, timestamp: 4003n }, sealed('3980'))).toBe('expired')
    expect(bootstrapRolloverGate({ ...state, timestamp: 4001n }, sealed('3985'))).toBe('expired')
    expect(bootstrapRolloverGate({ ...state, timestamp: 4000n }, null)).toBe('expired')
    expect(bootstrapRolloverGate({ ...state, timestamp: 4002n }, sealed('4001'))).toBe('expired')
  })
  test('missing, invalid, future and malformed captures cannot authorize rollover', () => {
    for (const sample of [null, {}, sealed('3999', false), sealed('4001'), sealed('bad')]) {
      expect(bootstrapRolloverGate({ ...state, timestamp: 3999n }, sample)).toBe('wait-for-seal')
    }
  })
  test('signed work and existing sweeps reconcile, and an initial unquoted epoch can advance', () => {
    for (const overrides of [{ pending: true }, { work: 1 }, { pricingMode: 1 }, { establishedLiquidity: false }, { timestamp: 3969n }]) {
      expect(bootstrapRolloverGate({ ...state, ...overrides }, null)).toBe('unneeded')
    }
  })
})
