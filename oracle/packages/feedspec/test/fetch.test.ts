// ADJ-36: the node-mode fetch both workflows share. A scripted requester stands in for the CRE SDK's.
import { expect, test } from 'bun:test'
import { keccak256, toBytes } from 'viem'
import { type NodeHttpRequest, nodeFetch, ZERO32 } from '../src/fetch'
import { type FeedSpec, MAX_BODY_BYTES, Op, ValueType } from '../src/index'

const spec: FeedSpec = {
  urlTemplate: 'https://api.example-sports.com/v1/events/{id}', urlParam: 'evt_1', authRef: ZERO32,
  finalPath: 'event.status', finalValue: 'FINAL', valuePath: 'event.home', valueType: ValueType.INT, decimals: 0,
  op: Op.GT, target: '2', bufferSecs: 900, l1TimeoutSecs: 21600,
}
const URL_ = 'https://api.example-sports.com/v1/events/evt_1'
const fetchAndEvaluate = nodeFetch({
  text: (r) => new TextDecoder('utf-8').decode(r.body).trim(),
  hashLexeme: (l) => keccak256(toBytes(l)),
})

function requester(reply: () => { statusCode: number; body: Uint8Array }) {
  const seen: NodeHttpRequest[] = []
  return { seen, r: { sendRequest: (req: NodeHttpRequest) => { seen.push(req); return { result: reply } } } }
}
const json = (s: string) => () => ({ statusCode: 200, body: new TextEncoder().encode(s) })

test('one GET with accept, no cache, the timeout given, and no auth header when none is given', () => {
  const { seen, r } = requester(json('{"event":{"status":"FINAL","home":3}}'))
  expect(fetchAndEvaluate(r, spec, URL_, '8s', '', '')).toBe(`YES|${keccak256(toBytes('3'))}|OK`)
  expect(seen).toEqual([{
    url: URL_, method: 'GET', multiHeaders: { accept: { values: ['application/json'] } },
    timeout: '8s', cacheSettings: { store: false },
  }])
})

test('an auth header is sent with its value', () => {
  const { seen, r } = requester(json('{"event":{"status":"FINAL","home":1}}'))
  expect(fetchAndEvaluate(r, spec, URL_, '8s', 'x-api-key', 'Key k')).toBe(`NO|${keccak256(toBytes('1'))}|OK`)
  expect(seen[0].multiHeaders['x-api-key']).toEqual({ values: ['Key k'] })
})

test('NOT_READY and ERROR carry the zero value hash', () => {
  expect(fetchAndEvaluate(requester(json('{"event":{"status":"LIVE","home":3}}')).r, spec, URL_, '8s', '', ''))
    .toBe(`NOT_READY|${ZERO32}|NOT_FINAL`)
  expect(fetchAndEvaluate(requester(json('{"event":{"status":"FINAL"}}')).r, spec, URL_, '8s', '', ''))
    .toBe(`ERROR|${ZERO32}|VALUE_MISSING`)
})

test('a body over 250 KiB is BODY_TOO_LARGE, before it is decoded', () => {
  let decoded = false
  const f = nodeFetch({ text: () => { decoded = true; return '' }, hashLexeme: (l) => l })
  const { r } = requester(() => ({ statusCode: 200, body: new Uint8Array(MAX_BODY_BYTES + 1) }))
  expect(f(r, spec, URL_, '8s', '', '')).toBe(`ERROR|${ZERO32}|BODY_TOO_LARGE`)
  expect(decoded).toBe(false)
})

test('a transport failure is FETCH_FAILED', () => {
  const { r } = requester(() => { throw new Error('timeout') })
  expect(fetchAndEvaluate(r, spec, URL_, '8s', '', '')).toBe(`ERROR|${ZERO32}|FETCH_FAILED`)
})
