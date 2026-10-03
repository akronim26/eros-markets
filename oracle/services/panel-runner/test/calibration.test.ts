// Task O33.3: calibration (clipping, flooring, exact arithmetic), calibratorHash and the reviewers' candidate.
// Expected values are worked by hand below; the hash is checked against a canonical string written out by hand.
import { canonicalize } from '@eros-oracle/snapshotter'
import { describe, expect, test } from 'bun:test'
import { keccak256, stringToBytes } from 'viem'
import {
  calibrate,
  calibratedBps,
  CalibrationError,
  type CalibrationMap,
  calibratorHash,
  candidate,
  checkMap,
  placeholderMaps,
  rational,
} from '../src/calibration'
import type { ModelOutcome } from '../src/models/client'

const M = 'groq:openai/gpt-oss-120b@2026-10-03'
const IDENTITY: CalibrationMap = { model: M, breakpoints: [[0, 0], [1, 1]] }
const STEPS: CalibrationMap = { model: M, breakpoints: [[0.2, 0.1], [0.5, 0.3], [0.8, 0.9]] }
const MODELS = ['groq:openai/gpt-oss-120b@2026-10-03', 'nvidia:moonshotai/kimi-k3@2026-10-03', 'google:gemini-3.8-flash@2026-10-03']

const outcome = (model: string, label: ModelOutcome['label'], confidence: number | null): ModelOutcome => ({
  model, modelIdHash: '0x00', label, labelCode: 0, confidence, cited: [], rationale: '', attempts: [],
})

describe('rational', () => {
  test('the shortest decimal form, exactly', () => {
    expect(rational(0.29)).toEqual({ n: 29n, d: 100n })
    expect(rational(1e-7)).toEqual({ n: 1n, d: 10_000_000n })
    expect(rational('2.5e3')).toEqual({ n: 2500n, d: 1n })
    expect(rational(1)).toEqual({ n: 1n, d: 1n })
    expect(() => rational(Number.NaN)).toThrow(CalibrationError)
  })
})

describe('calibratedBps', () => {
  test('flooring is exact: 0.071 is 710, not 709 (in doubles 0.071 × 10000 = 709.9999999999999)', () => {
    expect(Math.floor(0.071 * 10000)).toBe(709) // what float arithmetic would sign
    expect(calibratedBps(IDENTITY, 0.071)).toBe(710)
    // every basis point a model can state as a 4-place decimal comes back as itself (564 of these 9,801 fail in doubles)
    for (let k = 100; k <= 9900; k++) expect(calibratedBps(IDENTITY, Number(`0.${String(k).padStart(4, '0')}`))).toBe(k)
    expect(calibratedBps(IDENTITY, 0.57)).toBe(5700)
    expect(calibratedBps(IDENTITY, 0.12345)).toBe(1234) // floor, not round
    expect(calibratedBps(IDENTITY, 0.99999)).toBe(9900) // clipped first
  })

  test('clipping to [0.01, 0.99]', () => {
    expect(calibratedBps(IDENTITY, 0)).toBe(100)
    expect(calibratedBps(IDENTITY, 0.005)).toBe(100)
    expect(calibratedBps(IDENTITY, 0.01)).toBe(100)
    expect(calibratedBps(IDENTITY, 0.99)).toBe(9900)
    expect(calibratedBps(IDENTITY, 1)).toBe(9900)
  })

  test('linear between breakpoints, the end values outside', () => {
    expect(calibratedBps(STEPS, 0.1)).toBe(1000) // below the first: 0.1
    expect(calibratedBps(STEPS, 0.2)).toBe(1000)
    expect(calibratedBps(STEPS, 0.35)).toBe(2000) // 0.1 + 0.2 × (0.15 / 0.3) = 0.2
    expect(calibratedBps(STEPS, 0.5)).toBe(3000)
    expect(calibratedBps(STEPS, 0.6)).toBe(5000) // 0.3 + 0.6 × (0.1 / 0.3) = 0.5
    expect(calibratedBps(STEPS, 0.7)).toBe(7000) // 0.3 + 0.6 × (0.2 / 0.3) = 0.7 exactly
    expect(calibratedBps(STEPS, 0.61)).toBe(5200) // 0.3 + 0.6 × 0.11 / 0.3 = 0.52
    expect(calibratedBps(STEPS, 0.95)).toBe(9000) // above the last: 0.9
    expect(calibratedBps({ model: M, breakpoints: [[0, 0], [0.3, 1]] }, 0.1)).toBe(3333) // 1/3 floored
  })

  test('confidence outside [0, 1] is refused', () => {
    expect(() => calibratedBps(IDENTITY, 1.01)).toThrow(CalibrationError)
    expect(() => calibratedBps(IDENTITY, -0.01)).toThrow(CalibrationError)
  })

  test('the placeholder gives 4,900 for every confidence: below the 5,000 bps highConfBps floor', () => {
    const [p] = placeholderMaps([M])
    for (const c of [0, 0.3, 0.5, 0.99, 1]) expect(calibratedBps(p, c)).toBe(4900)
  })
})

describe('maps and calibratorHash', () => {
  test('a map must have increasing confidences and a non-decreasing value, all in [0, 1]', () => {
    expect(() => checkMap(STEPS)).not.toThrow()
    expect(() => checkMap({ model: M, breakpoints: [[0, 0]] })).toThrow(CalibrationError)
    expect(() => checkMap({ model: M, breakpoints: [[0.5, 0.2], [0.5, 0.3]] })).toThrow('strictly increase')
    expect(() => checkMap({ model: M, breakpoints: [[0.1, 0.4], [0.5, 0.3]] })).toThrow('must not decrease')
    expect(() => checkMap({ model: M, breakpoints: [[0, 0], [1, 1.2]] })).toThrow('outside')
    expect(() => checkMap({ model: 'gpt', breakpoints: [[0, 0], [1, 1]] })).toThrow('bad model')
    expect(() => checkMap({ ...STEPS, fittedOn: 'train' } as CalibrationMap)).toThrow('exactly {model, breakpoints}') // nothing unhashed rides along
  })

  test('keccak256 of the JCS of the three maps, in order', () => {
    const maps = placeholderMaps(MODELS)
    const text =
      '[{"breakpoints":[[0,0.49],[1,0.49]],"model":"groq:openai/gpt-oss-120b@2026-10-03"},' +
      '{"breakpoints":[[0,0.49],[1,0.49]],"model":"nvidia:moonshotai/kimi-k3@2026-10-03"},' +
      '{"breakpoints":[[0,0.49],[1,0.49]],"model":"google:gemini-3.8-flash@2026-10-03"}]'
    expect(canonicalize(maps)).toBe(text)
    expect(calibratorHash(maps)).toBe(keccak256(stringToBytes(text)))
    expect(calibratorHash([maps[1], maps[0], maps[2]])).not.toBe(calibratorHash(maps)) // order is part of it
    expect(calibratorHash([{ breakpoints: maps[0].breakpoints, model: maps[0].model }, maps[1], maps[2]])).toBe(calibratorHash(maps)) // key order is not
    expect(() => calibratorHash(maps.slice(0, 2))).toThrow(CalibrationError)
  })
})

describe('calibrate', () => {
  test('ABSTAIN is 0; each model through its own map, in order', () => {
    const maps = [IDENTITY, { ...STEPS, model: MODELS[1] }, ...placeholderMaps([MODELS[2]])].map((m, i) => ({ ...m, model: MODELS[i] }))
    const out = [outcome(MODELS[0], 'YES', 0.93), outcome(MODELS[1], 'NO', 0.6), outcome(MODELS[2], 'ABSTAIN', 0.9)]
    expect(calibrate(out, maps)).toEqual([9300, 5000, 0])
    expect(() => calibrate(out, [maps[1], maps[0], maps[2]])).toThrow(CalibrationError)
  })
})

describe('candidate (display only)', () => {
  test('independent models: ℓ = Σ s_i·logit(ĉ_i)', () => {
    const out = [outcome(MODELS[0], 'YES', 0.9), outcome(MODELS[1], 'YES', 0.8), outcome(MODELS[2], 'NO', 0.6)]
    const c = candidate(out, [9000, 8000, 6000])
    const expected = Math.log(9) + Math.log(4) - Math.log(1.5) // logit(0.9) + logit(0.8) − logit(0.6)
    expect(c.nEff).toBe(3)
    expect(c.logOdds).toBeCloseTo(expected, 12)
    expect(c.probabilityYes).toBeCloseTo(1 / (1 + Math.exp(-expected)), 12)
  })

  test('correlated models count for less: n_eff = n² / Σρ', () => {
    const out = [outcome(MODELS[0], 'YES', 0.9), outcome(MODELS[1], 'YES', 0.9), outcome(MODELS[2], 'YES', 0.9)]
    const rho = [[1, 0.5, 0.5], [0.5, 1, 0.5], [0.5, 0.5, 1]] // Σρ = 6 → n_eff = 1.5
    const c = candidate(out, [9000, 9000, 9000], rho)
    expect(c.nEff).toBe(1.5)
    expect(c.logOdds).toBeCloseTo(0.5 * 3 * Math.log(9), 12)
  })

  test('INVALID, NOT_YET and ABSTAIN add nothing', () => {
    const out = [outcome(MODELS[0], 'INVALID', 0.9), outcome(MODELS[1], 'NOT_YET', 0.9), outcome(MODELS[2], 'ABSTAIN', null)]
    expect(candidate(out, [9000, 9000, 0]).logOdds).toBe(0)
  })
})
