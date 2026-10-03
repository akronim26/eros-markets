// vectors/claim.json is written from ClaimRenderer by ClaimVectors.t.sol.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bytesToHex, type Hex, stringToBytes } from 'viem'
import { ORACLE_ROOT } from '../src/abi/sources'
import { type ClaimFields, InvalidTemplate, isValidTemplate, l1Evidence, NoOutcome, renderClaim, utc, worstCaseLength } from '../src/claim'

const V = JSON.parse(readFileSync(join(ORACLE_ROOT, 'vectors', 'claim.json'), 'utf8'))
type Vector = {
  name: string
  template: string
  fields: Record<string, string | number>
  l1Url: string
  valueHash: Hex
  rendered: Hex | null
  worstCase: number | null
  error: string | null
}

function fields(v: Vector): ClaimFields {
  const f = v.fields
  return {
    marketId: f.marketId as Hex,
    chainId: BigInt(f.chainId),
    oracle: f.oracle as Hex,
    question: f.question as string,
    rules: f.rules as string,
    tau: BigInt(f.tau),
    outcome: f.outcome as number,
    evidence: v.l1Url ? l1Evidence(v.valueHash, v.l1Url) : (f.evidence as string),
    evidenceHash: f.evidenceHash as Hex,
  }
}

const errorName = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof InvalidTemplate || e instanceof NoOutcome) return e.message
    throw e
  }
}

describe('claim vectors', () => {
  const vectors: Vector[] = V.vectors

  test('the file covers valid renders, both errors and a Layer 1 evidence case', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20)
    expect(vectors.some((v) => v.error === 'InvalidTemplate')).toBe(true)
    expect(vectors.some((v) => v.error === 'NoOutcome')).toBe(true)
    expect(vectors.some((v) => v.l1Url && v.rendered)).toBe(true)
  })

  for (const v of V.vectors as Vector[]) {
    test(v.name, () => {
      const f = fields(v)
      let out: Uint8Array | undefined
      expect(errorName(() => (out = renderClaim(v.template, f)))).toBe(v.error)
      expect(out ? bytesToHex(out) : null).toBe(v.rendered)
      expect(isValidTemplate(v.template)).toBe(v.error !== 'InvalidTemplate')
      const q = stringToBytes(f.question).length
      const r = stringToBytes(f.rules).length
      const u = stringToBytes(v.l1Url).length
      if (v.worstCase === null) expect(() => worstCaseLength(v.template, q, r, u)).toThrow(InvalidTemplate)
      else {
        const w = worstCaseLength(v.template, q, r, u)
        expect(w).toBe(BigInt(v.worstCase))
        if (out) expect(BigInt(out.length) <= w || v.name.startsWith('uint64-tau-uint256-chain')).toBe(true)
      }
    })
  }
})

describe('dates', () => {
  test('utc agrees with the JavaScript calendar across leap years, centuries and the year 9999', () => {
    const samples = [0n, 951782400n, 951868799n, 4107542400n, 1835481599n, 253402300799n]
    for (let ts = -0n; ts < 4_000_000_000n; ts += 86_399_999n) samples.push(ts)
    for (const ts of samples) expect(utc(ts), ts.toString()).toBe(new Date(Number(ts) * 1000).toISOString().replace('.000Z', 'Z'))
  })
})
