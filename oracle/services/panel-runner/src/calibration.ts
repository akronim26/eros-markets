// Calibration: each model has an isotonic map given as breakpoints [[c, g(c)], ...], linear between them and flat
// outside. calibratedBps = floor(clip(g(c), 0.01, 0.99) × 10000), computed on exact rationals of each number's
// shortest decimal form, so a value on a basis-point boundary is never floored one short.
// PLACEHOLDER_MAPS give 4,900 bps, below the 5,000 bps floor of any highConfBps, so they can never pass the gate.
import { canonicalize } from '@eros-oracle/snapshotter'
import { type Hex, keccak256, stringToBytes } from 'viem'
import type { ModelOutcome } from './models/client'

export type CalibrationMap = { model: string; breakpoints: [number, number][] }

export const CLIP_LOW = '0.01'
export const CLIP_HIGH = '0.99'
export const BPS = 10_000n

export class CalibrationError extends Error {}

/** An exact rational n/d (d > 0). */
type Q = { n: bigint; d: bigint }

/** "0.29" → 29/100, "1e-7" → 1/10^7. */
export function rational(x: number | string): Q {
  const s = typeof x === 'number' ? String(x) : x
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s)
  if (!m || (typeof x === 'number' && !Number.isFinite(x))) throw new CalibrationError(`${s} is not a finite decimal`)
  const digits = BigInt(m[2] + (m[3] ?? ''))
  const exp = BigInt(m[4] ?? 0) - BigInt((m[3] ?? '').length)
  const n = m[1] === '-' ? -digits : digits
  return exp >= 0n ? { n: n * 10n ** exp, d: 1n } : { n, d: 10n ** -exp }
}

const cmp = (a: Q, b: Q) => (a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0)
const sub = (a: Q, b: Q): Q => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d })
const add = (a: Q, b: Q): Q => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })
const mul = (a: Q, b: Q): Q => ({ n: a.n * b.n, d: a.d * b.d })
const div = (a: Q, b: Q): Q => (b.n < 0n ? { n: -a.n * b.d, d: a.d * -b.n } : { n: a.n * b.d, d: a.d * b.n })
const floorQ = (a: Q) => (a.n >= 0n ? a.n / a.d : -((-a.n + a.d - 1n) / a.d))

/**
 * Exactly {model, breakpoints} (the whole map is hashed), ≥ 2 breakpoints, c strictly increasing and g non-decreasing,
 * both in [0, 1].
 */
export function checkMap(m: CalibrationMap): void {
  if (typeof m.model !== 'string' || !/^[a-z0-9-]+:[^@\s]+@\S+$/.test(m.model)) throw new CalibrationError(`bad model ${JSON.stringify(m.model)}`)
  const keys = Object.keys(m).sort().join(',')
  if (keys !== 'breakpoints,model') throw new CalibrationError(`${m.model}: a map is exactly {model, breakpoints}, got {${keys}}`)
  const b = m.breakpoints
  if (!Array.isArray(b) || b.length < 2) throw new CalibrationError(`${m.model}: at least two breakpoints`)
  const zero = rational(0)
  const one = rational(1)
  b.forEach(([c, g], i) => {
    const [qc, qg] = [rational(c), rational(g)]
    if (cmp(qc, zero) < 0 || cmp(qc, one) > 0 || cmp(qg, zero) < 0 || cmp(qg, one) > 0) throw new CalibrationError(`${m.model}: breakpoint ${i} outside [0, 1]`)
    if (i > 0) {
      if (cmp(qc, rational(b[i - 1][0])) <= 0) throw new CalibrationError(`${m.model}: confidences must strictly increase (breakpoint ${i})`)
      if (cmp(qg, rational(b[i - 1][1])) < 0) throw new CalibrationError(`${m.model}: the map must not decrease (breakpoint ${i})`)
    }
  })
}

function apply(m: CalibrationMap, c: Q): Q {
  const b = m.breakpoints.map(([x, y]) => [rational(x), rational(y)] as const)
  if (cmp(c, b[0][0]) <= 0) return b[0][1]
  if (cmp(c, b.at(-1)![0]) >= 0) return b.at(-1)![1]
  const i = b.findIndex(([x]) => cmp(x, c) > 0) // i ≥ 1
  const [x0, y0] = b[i - 1]
  const [x1, y1] = b[i]
  return add(y0, mul(sub(y1, y0), div(sub(c, x0), sub(x1, x0))))
}

export function calibratedBps(m: CalibrationMap, confidence: number): number {
  const c = rational(confidence)
  if (cmp(c, rational(0)) < 0 || cmp(c, rational(1)) > 0) throw new CalibrationError(`confidence ${confidence} outside [0, 1]`)
  let g = apply(m, c)
  const lo = rational(CLIP_LOW)
  const hi = rational(CLIP_HIGH)
  if (cmp(g, lo) < 0) g = lo
  if (cmp(g, hi) > 0) g = hi
  return Number(floorQ(mul(g, { n: BPS, d: 1n })))
}

/** keccak256 of the JCS of the maps, in modelIdHashes order. */
export function calibratorHash(maps: readonly CalibrationMap[]): Hex {
  if (maps.length !== 3) throw new CalibrationError(`three maps, got ${maps.length}`)
  maps.forEach(checkMap)
  return keccak256(stringToBytes(canonicalize(maps)))
}

export const placeholderMaps = (models: readonly string[]): CalibrationMap[] =>
  models.map((model) => ({ model, breakpoints: [[0, 0.49], [1, 0.49]] }))

/** 0 for an ABSTAIN. The maps must match the outcomes' models, in order. */
export function calibrate(outcomes: readonly ModelOutcome[], maps: readonly CalibrationMap[]): number[] {
  if (outcomes.length !== maps.length) throw new CalibrationError('one map per model')
  return outcomes.map((o, i) => {
    if (maps[i].model !== o.model) throw new CalibrationError(`map ${i} is for ${maps[i].model}, not ${o.model}`)
    return o.label === 'ABSTAIN' || o.confidence === null ? 0 : calibratedBps(maps[i], o.confidence)
  })
}

export type Candidate = { logOdds: number; probabilityYes: number; nEff: number }

/**
 * Display-only score for reviewers, never part of the gate: ℓ = (n_eff / n) Σ s_i·logit(ĉ_i), n_eff = n² / Σ ρ_ij,
 * s_i = +1 for YES, −1 for NO, else 0. ρ defaults to the identity.
 */
export function candidate(outcomes: readonly ModelOutcome[], bps: readonly number[], rho?: readonly (readonly number[])[]): Candidate {
  const n = outcomes.length
  const r = rho ?? outcomes.map((_, i) => outcomes.map((__, j) => (i === j ? 1 : 0)))
  const sumRho = r.flat().reduce((a, b) => a + b, 0)
  const nEff = (n * n) / sumRho
  let sum = 0
  outcomes.forEach((o, i) => {
    const s = o.label === 'YES' ? 1 : o.label === 'NO' ? -1 : 0
    if (s === 0) return
    const c = bps[i] / 10_000
    sum += s * Math.log(c / (1 - c))
  })
  const logOdds = (nEff / n) * sum
  return { logOdds, probabilityYes: 1 / (1 + Math.exp(-logOdds)), nEff }
}
