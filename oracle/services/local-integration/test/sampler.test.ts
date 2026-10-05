import { describe, expect, test } from 'bun:test'
import { localSamplerGas } from '../src/sampler'

describe('local sampler measured gas', () => {
  test('uses upward padding on the actual estimate', () => {
    expect(localSamplerGas(100_001n)).toBe(140_002)
    expect(localSamplerGas(100_000n)).toBe(140_000)
    expect(localSamplerGas(100_001n, 300)).toBe(310_003)
  })

  test('never exceeds the 30M transaction ceiling', () => {
    expect(localSamplerGas(29_000_000n)).toBe(30_000_000)
    expect(localSamplerGas(30_000_000n)).toBe(30_000_000)
  })

  test('refuses unmeasured and impossible limits', () => {
    for (const padding of [99, 301, 130.5, NaN]) expect(() => localSamplerGas(100_000n, padding)).toThrow('PADDING')
    for (const estimate of [0n, -1n, 30_000_001n]) {
      expect(() => localSamplerGas(estimate)).toThrow('LOCAL_SAMPLER_GAS_OUT_OF_BOUNDS')
    }
  })
})
