import { describe, expect, test } from 'bun:test'
import {
  allowListed,
  buildUrl,
  checkTemplate,
  compare,
  EvalError,
  evaluateResponse,
  type FeedSpec,
  hostOf,
  MAX_BODY_BYTES,
  Op,
  parseJson,
  parseTyped,
  resolvePath,
  validatePath,
  ValueType,
} from '../src/index'

/** Home score > 2 once the event is FINAL. */
const SPEC: FeedSpec = {
  urlTemplate: 'https://api.example-sports.com/v1/events/{id}',
  urlParam: 'evt_1',
  authRef: '0x' + '00'.repeat(32),
  finalPath: 'event.status',
  finalValue: 'FINAL',
  valuePath: 'event.home',
  valueType: ValueType.INT,
  decimals: 0,
  op: Op.GT,
  target: '2',
  bufferSecs: 900,
  l1TimeoutSecs: 21600,
}

const evalBody = (spec: FeedSpec, body: string, statusCode = 200) =>
  evaluateResponse(spec, statusCode, body, new TextEncoder().encode(body).length)

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof EvalError) return e.code
    throw e
  }
  return 'OK'
}

describe('§11.2 evaluator cases', () => {
  test('finished event -> YES and NO', () => {
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":3}}')).toEqual({ status: 'YES', code: 'OK', valueLexeme: '3' })
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":2}}')).toEqual({ status: 'NO', code: 'OK', valueLexeme: '2' })
  })

  test('live event -> NOT_READY (finality missing or not equal byte for byte)', () => {
    expect(evalBody(SPEC, '{"event":{"status":"LIVE","home":3}}').status).toBe('NOT_READY')
    expect(evalBody(SPEC, '{"event":{"home":3}}').status).toBe('NOT_READY')
    expect(evalBody(SPEC, '{"event":{"status":"final","home":3}}').status).toBe('NOT_READY') // case-sensitive
    expect(evalBody(SPEC, '{"event":{"status":"FINAL ","home":3}}').status).toBe('NOT_READY')
    expect(evalBody(SPEC, '{"event":{"status":{"v":"FINAL"},"home":3}}').status).toBe('NOT_READY') // not a scalar
  })

  test('wrong value path -> ERROR VALUE_MISSING; malformed path -> ERROR BAD_PATH', () => {
    expect(evalBody({ ...SPEC, valuePath: 'event.away' }, '{"event":{"status":"FINAL","home":3}}')).toEqual({
      status: 'ERROR',
      code: 'VALUE_MISSING',
      valueLexeme: '',
    })
    expect(evalBody({ ...SPEC, valuePath: 'event..home' }, '{"event":{"status":"FINAL","home":3}}').code).toBe('BAD_PATH')
  })

  test('DECIMAL 3.10 equals 3.1 at decimals 2', () => {
    const dec: FeedSpec = { ...SPEC, valueType: ValueType.DECIMAL, decimals: 2, op: Op.EQ, target: '3.1' }
    expect(evalBody(dec, '{"event":{"status":"FINAL","home":3.10}}').status).toBe('YES')
    expect(parseTyped('3.10', ValueType.DECIMAL, 2)).toBe(310n)
    expect(parseTyped('3.1', ValueType.DECIMAL, 2)).toBe(310n)
    expect(parseTyped('3', ValueType.DECIMAL, 2)).toBe(300n)
    expect(parseTyped('-0.5', ValueType.DECIMAL, 2)).toBe(-50n)
  })

  test('DECIMAL 3.105 at decimals 2 -> ERROR (never rounds)', () => {
    const dec: FeedSpec = { ...SPEC, valueType: ValueType.DECIMAL, decimals: 2, op: Op.EQ, target: '3.1' }
    expect(evalBody(dec, '{"event":{"status":"FINAL","home":3.105}}')).toEqual({
      status: 'ERROR',
      code: 'TOO_MANY_DECIMALS',
      valueLexeme: '',
    })
  })

  test('exponent -> ERROR', () => {
    const dec: FeedSpec = { ...SPEC, valueType: ValueType.DECIMAL, decimals: 2, op: Op.GT, target: '2' }
    expect(evalBody(dec, '{"event":{"status":"FINAL","home":3e0}}').code).toBe('BAD_DECIMAL')
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":3E2}}').code).toBe('BAD_INT')
    expect(codeOf(() => parseTyped('1e3', ValueType.DECIMAL, 0))).toBe('BAD_DECIMAL')
  })

  test('INT rejects 3.0 and "03" (and +3, 03 as a number lexeme cannot occur)', () => {
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":3.0}}').code).toBe('BAD_INT')
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":"03"}}').code).toBe('BAD_INT')
    expect(codeOf(() => parseTyped('+3', ValueType.INT, 0))).toBe('BAD_INT')
    expect(codeOf(() => parseTyped('-0', ValueType.INT, 0))).toBe('OK') // the regex allows it; it is 0
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":"3"}}').status).toBe('YES') // numeric string
  })

  test('HTTP 429 and 5xx, oversize body and invalid JSON -> ERROR', () => {
    const ok = '{"event":{"status":"FINAL","home":3}}'
    expect(evalBody(SPEC, ok, 429)).toEqual({ status: 'ERROR', code: 'HTTP_429', valueLexeme: '' })
    expect(evalBody(SPEC, ok, 500).code).toBe('HTTP_500')
    expect(evalBody(SPEC, ok, 503).code).toBe('HTTP_503')
    expect(evalBody(SPEC, ok, 301).code).toBe('HTTP_301')
    expect(evaluateResponse(SPEC, 200, ok, MAX_BODY_BYTES + 1).code).toBe('BODY_TOO_LARGE')
    expect(evaluateResponse(SPEC, 200, ok, MAX_BODY_BYTES).status).toBe('YES') // exactly 250 KiB is allowed
    for (const bad of ['', '{', '{"event":}', "{'event':1}", '{"a":1,}', '[1,]', '{"a":1} x', 'NaN', '{"a":01}']) {
      expect(evalBody(SPEC, bad)).toEqual({ status: 'ERROR', code: 'INVALID_JSON', valueLexeme: '' })
    }
  })

  test('STRING allows only EQ and NEQ', () => {
    const s: FeedSpec = { ...SPEC, valuePath: 'event.winner', valueType: ValueType.STRING, op: Op.EQ, target: 'HOME' }
    const body = '{"event":{"status":"FINAL","winner":"HOME"}}'
    expect(evalBody(s, body).status).toBe('YES')
    expect(evalBody({ ...s, op: Op.NEQ }, body).status).toBe('NO')
    for (const op of [Op.GT, Op.GTE, Op.LT, Op.LTE]) {
      expect(evalBody({ ...s, op }, body).code).toBe('BAD_OP_FOR_STRING')
    }
    expect(evalBody(s, '{"event":{"status":"FINAL","winner":1}}').code).toBe('VALUE_NOT_STRING')
  })

  test('big integers keep precision (no float on any value)', () => {
    const big = '123456789012345678901234567890'
    const s: FeedSpec = { ...SPEC, valuePath: 'v', finalPath: 'f', finalValue: 'true', op: Op.EQ, target: big }
    expect(evalBody(s, `{"f":true,"v":${big}}`)).toEqual({ status: 'YES', code: 'OK', valueLexeme: big })
    expect(evalBody(s, `{"f":true,"v":${big.slice(0, -1)}1}`).status).toBe('NO') // differs in the last digit
    // 2^53 + 1 is not representable as a double: a float-based evaluator would call these equal.
    const s53: FeedSpec = { ...s, target: '9007199254740993' }
    expect(evalBody(s53, '{"f":true,"v":9007199254740992}').status).toBe('NO')
    expect(evalBody(s53, '{"f":true,"v":9007199254740993}').status).toBe('YES')
    const dec: FeedSpec = { ...s, valueType: ValueType.DECIMAL, decimals: 18, target: '0.100000000000000001' }
    expect(evalBody(dec, '{"f":true,"v":0.100000000000000001}').status).toBe('YES')
    expect(evalBody(dec, '{"f":true,"v":0.1}').status).toBe('NO')
  })

  test('duplicate keys are rejected as ambiguous', () => {
    expect(evalBody(SPEC, '{"event":{"status":"FINAL","home":1,"home":3}}').code).toBe('DUPLICATE_KEY')
    expect(codeOf(() => parseJson('{"a":1,"a":1}'))).toBe('DUPLICATE_KEY')
  })
})

describe('URL and host rules', () => {
  test('buildUrl substitutes {id} once', () => {
    expect(buildUrl(SPEC)).toBe('https://api.example-sports.com/v1/events/evt_1')
    expect(buildUrl({ ...SPEC, urlTemplate: 'https://api.example-sports.com/v1/live' })).toBe(
      'https://api.example-sports.com/v1/live',
    )
    expect(buildUrl({ ...SPEC, urlTemplate: 'https://api.example-sports.com/e?id={id}&x=1' })).toBe(
      'https://api.example-sports.com/e?id=evt_1&x=1',
    ) // '?' ends the host and a '/' follows it
  })

  test('{id} must come after the first "/" that follows the host (registry rule)', () => {
    const t = (urlTemplate: string) => codeOf(() => buildUrl({ ...SPEC, urlTemplate }))
    expect(t('https://{id}.example-sports.com/x')).toBe('BAD_HOST') // inside the host: a host failure first
    expect(t('https://api.example-sports.com?id={id}')).toBe('ID_NOT_IN_PATH') // no '/' after the host
    expect(t('https://api.example-sports.com?id={id}/x')).toBe('ID_NOT_IN_PATH') // before the first '/'
    expect(t('https://api.example-sports.com#{id}')).toBe('ID_NOT_IN_PATH')
    expect(t('https://api.example-sports.com/{id}')).toBe('OK')
    expect(t('https://api.example-sports.com/a/{id}/{id}')).toBe('MULTIPLE_ID_PLACEHOLDERS')
    // A param that would make the substituted host valid does not rescue a template the registry refuses.
    expect(codeOf(() => buildUrl({ ...SPEC, urlTemplate: 'https://{id}.example-sports.com/x', urlParam: 'abc' }))).toBe(
      'BAD_HOST',
    )
  })

  test('the template is checked before the urlParam, as the registry orders BadFeed codes', () => {
    expect(codeOf(() => buildUrl({ ...SPEC, urlTemplate: 'http://api.example-sports.com/{id}', urlParam: 'a b' }))).toBe(
      'NOT_HTTPS',
    )
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: 'a b' }))).toBe('BAD_URL_PARAM')
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: '' }))).toBe('BAD_URL_PARAM')
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: 'x'.repeat(128) }))).toBe('OK')
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: 'x'.repeat(129) }))).toBe('BAD_URL_PARAM')
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: 'a/b' }))).toBe('BAD_URL_PARAM')
    expect(codeOf(() => buildUrl({ ...SPEC, urlParam: 'a$&b' }))).toBe('BAD_URL_PARAM')
    // urlParam is checked even without {id}, as the registry does
    expect(codeOf(() => buildUrl({ ...SPEC, urlTemplate: 'https://api.example-sports.com/x', urlParam: '' }))).toBe(
      'BAD_URL_PARAM',
    )
  })

  test('hosts: https only, lowercase labels, no port, no userinfo, at least two labels', () => {
    expect(hostOf('https://api.example-sports.com/x')).toBe('api.example-sports.com')
    const bad = [
      'http://api.example.com/x',
      'HTTPS://api.example.com/x',
      'https://API.example.com/x',
      'https://api.example.com:443/x',
      'https://user@api.example.com/x',
      'https://localhost/x',
      'https://-api.example.com/x',
      'https://api-.example.com/x',
      'https://api..example.com/x',
      `https://${'a'.repeat(64)}.com/x`,
      'https://api_x.example.com/x',
      'https://',
    ]
    for (const u of bad) expect(['NOT_HTTPS', 'BAD_HOST']).toContain(codeOf(() => hostOf(u)))
    expect(codeOf(() => hostOf(`https://${'a'.repeat(63)}.com`))).toBe('OK')
    expect(codeOf(() => checkTemplate('https://api.example-sports.com'))).toBe('OK')
  })

  test('allowListed: the URL host must equal allowList[0]', () => {
    const url = 'https://api.example-sports.com/v1/events/evt_1'
    expect(allowListed(url, ['api.example-sports.com', 'stats.example-data.org'])).toBe(true)
    expect(allowListed(url, ['stats.example-data.org', 'api.example-sports.com'])).toBe(false)
    expect(allowListed(url, [])).toBe(false)
    expect(allowListed('http://api.example-sports.com/x', ['api.example-sports.com'])).toBe(false)
  })
})

describe('parser and paths', () => {
  test('numbers keep their exact lexeme', () => {
    const root = parseJson('{"a":[1,-2.50,3e-7,0]}')
    const a = resolvePath(root, 'a')
    expect(a?.k === 'arr' && a.v.map((n) => (n.k === 'num' ? n.v : ''))).toEqual(['1', '-2.50', '3e-7', '0'])
  })

  test('nesting depth is at most 64', () => {
    expect(codeOf(() => parseJson('['.repeat(65) + ']'.repeat(65)))).toBe('OK')
    expect(codeOf(() => parseJson('['.repeat(66) + ']'.repeat(66)))).toBe('INVALID_JSON')
  })

  test('strings: escapes decoded, raw control characters refused', () => {
    const root = parseJson('{"s":"a\\"b\\u0041\\n"}')
    expect(resolvePath(root, 's')).toEqual({ k: 'str', v: 'a"bA\n' })
    expect(codeOf(() => parseJson('{"s":"a\nb"}'))).toBe('INVALID_JSON')
    expect(codeOf(() => parseJson('{"s":"\\x"}'))).toBe('INVALID_JSON')
  })

  test('paths: segments, array indexes, limits', () => {
    const root = parseJson('{"a":{"b":[{"c":7}]},"$x":1,"__proto__":2}')
    expect(resolvePath(root, 'a.b[0].c')).toEqual({ k: 'num', v: '7' })
    expect(resolvePath(root, 'a.b[1].c')).toBeUndefined()
    expect(resolvePath(root, '$x')).toEqual({ k: 'num', v: '1' })
    expect(resolvePath(root, '__proto__')).toEqual({ k: 'num', v: '2' }) // a plain key, no prototype access
    expect(resolvePath(root, 'a.b.c')).toBeUndefined() // b is an array
    for (const p of ['', 'a..b', 'a.b[01]', 'a.b[1000000]', 'a b', '.a', 'a.', 'a[0', 'x'.repeat(257)]) {
      expect(validatePath(p)).toBe(false)
    }
    expect(validatePath('a.b[999999]')).toBe(true)
    expect(validatePath('x'.repeat(256))).toBe(true)
  })

  test('compare on integers', () => {
    expect(compare(3n, Op.GTE, 3n)).toBe(true)
    expect(compare(3n, Op.LT, 3n)).toBe(false)
    expect(compare(-1n, Op.LTE, 0n)).toBe(true)
  })
})
