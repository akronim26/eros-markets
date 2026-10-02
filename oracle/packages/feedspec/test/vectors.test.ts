// Task O20.2: the shared vectors (O02.2, O10.2) give the same results in TypeScript as in Foundry
// (test/unit/FeedSpecLib.t.sol reads the same files). Every validation case returns the exact BadFeed code
// the registry returns; every specHash, computed with viem's `encodeAbiParameters` on the FeedSpec tuple,
// equals the Solidity `keccak256(abi.encode(spec))`.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { type FeedSpec, type TimingBounds, validateSpec } from '../src/index'

type Case = { name: string; expectCode: number; l1Host: string; authRefKnown: boolean; spec: FeedSpec }
type HashVector = { name: string; spec: FeedSpec; specHash: Hex }

const feedVectors = (await Bun.file(new URL('../../../vectors/feedspec.json', import.meta.url)).json()) as {
  bounds: TimingBounds
  cases: Case[]
}
const hashVectors = (await Bun.file(new URL('../../../vectors/spechash.json', import.meta.url)).json()) as {
  vectors: HashVector[]
}

/** The FeedSpec tuple exactly as `abi.encode(FeedSpec)` lays it out (Appendix C.2 field order). */
const FEED_SPEC_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'urlTemplate', type: 'string' },
      { name: 'urlParam', type: 'string' },
      { name: 'authRef', type: 'bytes32' },
      { name: 'finalPath', type: 'string' },
      { name: 'finalValue', type: 'string' },
      { name: 'valuePath', type: 'string' },
      { name: 'valueType', type: 'uint8' },
      { name: 'decimals', type: 'uint8' },
      { name: 'op', type: 'uint8' },
      { name: 'target', type: 'string' },
      { name: 'bufferSecs', type: 'uint32' },
      { name: 'l1TimeoutSecs', type: 'uint32' },
    ],
  },
] as const

function specHash(s: FeedSpec): Hex {
  return keccak256(encodeAbiParameters(FEED_SPEC_TUPLE, [{ ...s, authRef: s.authRef as Hex }]))
}

describe('vectors/feedspec.json: listing validation parity', () => {
  test('the file covers every BadFeed code 0-12', () => {
    const codes = new Set(feedVectors.cases.map((c) => c.expectCode))
    for (let code = 0; code <= 12; code++) expect(codes.has(code)).toBe(true)
  })

  for (const c of feedVectors.cases) {
    test(`${c.name} -> ${c.expectCode}`, () => {
      expect(validateSpec(c.spec, c.l1Host, c.authRefKnown, feedVectors.bounds)).toBe(c.expectCode)
    })
  }
})

describe('vectors/spechash.json: specHash parity (viem encodeAbiParameters == Solidity abi.encode)', () => {
  test('B.3 is 0x5066…80cd', () => {
    const b3 = hashVectors.vectors[0]
    expect(b3.specHash).toBe('0x50661463875a7d2a9c9ca378a3d4d1ee141fef1d82091ecd7ab36829ea7f80cd')
    expect(specHash(b3.spec)).toBe(b3.specHash)
  })

  for (const v of hashVectors.vectors) {
    test(v.name, () => {
      expect(specHash(v.spec)).toBe(v.specHash)
    })
  }

  test('every field changes the hash', () => {
    const base = hashVectors.vectors[0].spec
    const h = specHash(base)
    const changed: FeedSpec[] = [
      { ...base, urlParam: 'evt_2' },
      { ...base, target: '3' },
      { ...base, decimals: 1 },
      { ...base, l1TimeoutSecs: base.l1TimeoutSecs + 1 },
      { ...base, authRef: '0x' + '00'.repeat(31) + '01' },
    ]
    for (const s of changed) expect(specHash(s)).not.toBe(h)
  })
})
