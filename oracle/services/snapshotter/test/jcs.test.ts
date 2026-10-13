// Expected values come from RFC 8785's examples, the reference implementation's test data (test/vectors/jcs) and
// hand-written canonical strings.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, stringToBytes } from 'viem'
import { takeSnapshot } from '../src/fetcher'
import { canonicalBytes, canonicalize, evidenceHash, JcsError } from '../src/jcs'
import { startFixture } from './fixture'

const VECTORS = fileURLToPath(new URL('./vectors/jcs/', import.meta.url))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const fromIeee = (h: string) => new DataView(Buffer.from(h.padStart(16, '0'), 'hex').buffer).getFloat64(0)

describe('RFC 8785 examples', () => {
  // §3.2.2: the sample object; §3.2.3: its canonical form (vector files, verbatim from the RFC); §3.2.4: its bytes
  const SAMPLE = readFileSync(join(VECTORS, 'rfc8785-3.2.2-sample.json'), 'utf8')
  const CANONICAL = readFileSync(join(VECTORS, 'rfc8785-3.2.3-canonical.json'), 'utf8')
  const BYTES =
    '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a ' +
    '5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37 ' +
    '5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d'

  test('§3.2.3: the sample, canonicalized', () => {
    expect(canonicalize(JSON.parse(SAMPLE))).toBe(CANONICAL)
  })

  test('§3.2.4: its UTF-8 bytes', () => {
    expect(hex(canonicalBytes(JSON.parse(SAMPLE)))).toBe(BYTES.replaceAll(' ', ''))
  })

  test('§3.2.3: property sorting by UTF-16 code units', () => {
    const o = JSON.parse(readFileSync(join(VECTORS, 'rfc8785-3.2.3-sorting.json'), 'utf8'))
    // read the order off the canonical text: a re-parsed JS object would list the integer-like key "1" first
    const text = canonicalize(o)
    const values = Object.values(o as Record<string, string>).sort((a, b) => text.indexOf(`:"${a}"`) - text.indexOf(`:"${b}"`))
    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ])
    expect(canonicalize({ ab: 0, aa: 0, a: 0, '': 0 })).toBe('{"":0,"a":0,"aa":0,"ab":0}')
  })

  test('Appendix B: number serialization samples', () => {
    const table: [string, string][] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ]
    for (const [ieee, json] of table) expect([ieee, canonicalize(fromIeee(ieee))]).toEqual([ieee, json])
    expect(() => canonicalize(fromIeee('7fffffffffffffff'))).toThrow(JcsError) // NaN
    expect(() => canonicalize(fromIeee('7ff0000000000000'))).toThrow(JcsError) // Infinity
  })
})

describe('reference test data', () => {
  const names = readdirSync(join(VECTORS, 'input')).filter((f) => f.endsWith('.json')).sort()

  test('six input/output pairs', () => {
    expect(names).toEqual(['arrays.json', 'french.json', 'structures.json', 'unicode.json', 'values.json', 'weird.json'])
  })

  for (const name of ['arrays.json', 'french.json', 'structures.json', 'unicode.json', 'values.json', 'weird.json']) {
    test(`${name}: the canonical bytes equal the expected output`, () => {
      const input = JSON.parse(readFileSync(join(VECTORS, 'input', name), 'utf8'))
      const expected = readFileSync(join(VECTORS, 'output', name))
      expect(hex(canonicalBytes(input))).toBe(expected.toString('hex'))
    })
  }

  test('ES6 number serialization: 10,000 lines of the reference file', () => {
    const lines = readFileSync(join(VECTORS, 'es6-numbers-10k.txt'), 'utf8').split(/\r?\n/).filter((l) => l !== '')
    expect(lines.length).toBe(10_000)
    const wrong: string[] = []
    for (const line of lines) {
      const [ieee, json] = line.split(',')
      if (canonicalize(fromIeee(ieee)) !== json) wrong.push(line)
    }
    expect(wrong).toEqual([])
  })
})

describe('strings', () => {
  test('controls: \\b \\t \\n \\f \\r, the rest as lowercase \\u00hh; quote and backslash escaped; DEL, U+2028 and / as is', () => {
    const all = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('')
    expect(canonicalize(all)).toBe(
      '"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f' +
        '\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f"',
    )
    expect(canonicalize('"\\\u007f\u2028/é😀')).toBe('"\\"\\\\\u007f\u2028/é😀"')
  })

  test('a lone surrogate, in a value or a key, is an error (RFC 8785 §3.2.2.2)', () => {
    for (const bad of ['\ud800', 'a\udc00', '\ud83d', '\ude00x', '\ud83d\ud83d']) {
      expect(() => canonicalize(bad)).toThrow(JcsError)
      expect(() => canonicalize({ [bad]: 1 })).toThrow(JcsError)
    }
  })
})

describe('values JSON cannot carry are errors, never dropped', () => {
  test.each([
    ['undefined', undefined],
    ['an undefined property', { a: undefined }],
    ['undefined in an array', [1, undefined]],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a Date', new Date(0)],
    ['a Uint8Array', new Uint8Array([1])],
    ['a Map', new Map()],
    ['-Infinity', -Infinity],
  ])('%s', (_, v) => {
    expect(() => canonicalize(v)).toThrow(JcsError)
  })

  test('a cycle is an error; the same object twice is not a cycle', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    expect(() => canonicalize(a)).toThrow(JcsError)
    const shared = { b: 2, a: 1 }
    expect(canonicalize([shared, { s: shared }])).toBe('[{"a":1,"b":2},{"s":{"a":1,"b":2}}]')
  })

  test('an object without a prototype is a plain object', () => {
    const o = Object.create(null)
    o.z = 1
    o.a = [true]
    expect(canonicalize(o)).toBe('{"a":[true],"z":1}')
  })
})

describe('evidenceHash', () => {
  // A snapshot written out by hand, and its canonical form written out by hand (keys sorted at every level).
  const SNAPSHOT = {
    version: 1,
    marketId: '0xe085067fb3e1eba632de103ba472329d833cddefdb9296cc70569d9b080d5fcf',
    takenAt: 1800000000,
    allowList: ['api.example-sports.com', 'stats.example-data.org'],
    items: [
      {
        url: 'https://api.example-sports.com/v1/events/evt_1',
        host: 'api.example-sports.com',
        allowListed: true,
        fetchedAt: 1800000001,
        httpStatus: 200,
        contentType: 'application/json',
        sha256: '19b5db2e423bdfa5fa33f04a9af9fc810ee2c87195c7c1deffc062d7b8f338ae',
        bytesBase64: 'eyJldmVudCI6eyJzdGF0dXMiOiJGSU5BTCIsImhvbWUiOjMsImF3YXkiOjF9fQ==',
        truncated: false,
      },
      {
        url: 'https://news.example.com/story',
        host: 'news.example.com',
        allowListed: false,
        fetchedAt: 1800000002,
        httpStatus: 0,
        contentType: '',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        bytesBase64: '',
        truncated: false,
        error: 'TIMEOUT',
      },
    ],
    omitted: [{ url: 'http://bad.example/x', reason: 'BAD_URL' }],
  }
  const CANONICAL =
    '{"allowList":["api.example-sports.com","stats.example-data.org"],"items":[' +
    '{"allowListed":true,"bytesBase64":"eyJldmVudCI6eyJzdGF0dXMiOiJGSU5BTCIsImhvbWUiOjMsImF3YXkiOjF9fQ==","contentType":"application/json",' +
    '"fetchedAt":1800000001,"host":"api.example-sports.com","httpStatus":200,"sha256":"19b5db2e423bdfa5fa33f04a9af9fc810ee2c87195c7c1deffc062d7b8f338ae",' +
    '"truncated":false,"url":"https://api.example-sports.com/v1/events/evt_1"},' +
    '{"allowListed":false,"bytesBase64":"","contentType":"","error":"TIMEOUT","fetchedAt":1800000002,"host":"news.example.com","httpStatus":0,' +
    '"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","truncated":false,"url":"https://news.example.com/story"}],' +
    '"marketId":"0xe085067fb3e1eba632de103ba472329d833cddefdb9296cc70569d9b080d5fcf",' +
    '"omitted":[{"reason":"BAD_URL","url":"http://bad.example/x"}],"takenAt":1800000000,"version":1}'

  test('keccak256 of the canonical UTF-8 bytes', () => {
    expect(canonicalize(SNAPSHOT)).toBe(CANONICAL)
    expect(evidenceHash(SNAPSHOT)).toBe(keccak256(stringToBytes(CANONICAL)))
  })

  describe('the same snapshot always gives the same hash', () => {
    let fx: ReturnType<typeof startFixture>
    beforeAll(() => {
      fx = startFixture()
    })
    afterAll(() => fx.stop())

    /** A deep copy with every object's keys in reverse insertion order. */
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v

    test('across serialization, re-parsing, key order and copies; and it moves with any change', async () => {
      let t = 1_800_000_000
      const s = await takeSnapshot(
        {
          marketId: SNAPSHOT.marketId,
          l1Url: 'https://api.example-sports.com/v1/events/evt_1',
          allowList: SNAPSHOT.allowList,
          pages: ['https://stats.example-data.org/match/1', 'https://news.example.com/story', 'https://stats.example-data.org/logo.png'],
        },
        { fetchFn: fx.fetchFn, clock: () => t++ },
      )
      const h = evidenceHash(s)
      expect(h).toMatch(/^0x[0-9a-f]{64}$/)
      expect(evidenceHash(s)).toBe(h)
      expect(evidenceHash(JSON.parse(JSON.stringify(s, null, 2)))).toBe(h) // pinned as pretty JSON, read back
      expect(evidenceHash(JSON.parse(canonicalize(s)))).toBe(h) // pinned canonical, read back
      expect(evidenceHash(reversed(s))).toBe(h)
      expect(evidenceHash(structuredClone(s))).toBe(h)
      expect(canonicalize(JSON.parse(canonicalize(s)))).toBe(canonicalize(s)) // idempotent

      const changed = [
        { ...s, items: [...s.items].reverse() },
        { ...s, items: s.items.map((i, k) => (k === 1 ? { ...i, bytesBase64: Buffer.from(Buffer.from(i.bytesBase64, 'base64').map((b, j) => (j === 0 ? b ^ 1 : b))).toString('base64') } : i)) },
        { ...s, takenAt: s.takenAt + 1 },
        { ...s, omitted: [{ url: 'http://bad.example/x', reason: 'BAD_URL' as const }] },
        { ...s, items: s.items.map((i, k) => (k === 0 ? { ...i, allowListed: false } : i)) },
      ]
      for (const c of changed) expect(evidenceHash(c)).not.toBe(h)
    })
  })
})
