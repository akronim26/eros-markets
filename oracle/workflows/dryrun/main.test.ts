// Task O22.1: the dry-run handler with the CRE SDK test runtime (plan §7.5, §12.9 step 3). A finished event
// prints YES or NO, a live one NOT_READY, a wrong path or a bad response ERROR, and no case writes anything:
// an EvmMock with a writeReport double is registered for every run and must stay untouched.
import { expect } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { getNetwork } from '@chainlink/cre-sdk'
import { CRON_TRIGGER_PB } from '@chainlink/cre-sdk/pb'
import { keccak256, parseAbi, toBytes } from 'viem'
import { onDryRun } from './main'
import sample from './config.sample.json'

const ZERO32 = `0x${'00'.repeat(32)}`
type Cfg = typeof sample
type Opts = { body?: string; status?: number; cfg?: Cfg; secrets?: Map<string, Map<string, string>> }

function run(o: Opts = {}) {
  const net = getNetwork({ chainFamily: 'evm', chainSelectorName: 'monad-testnet', isTestnet: true })!
  const evm = EvmMock.testInstance(net.chainSelector.selector)
  const anyContract = addContractMock(evm, {
    address: '0x00000000000000000000000000000000000000AA',
    abi: parseAbi(['function getL1Job(bytes32) view returns (uint8)']),
  })
  const writes: unknown[] = []
  anyContract.writeReport = (input) => { writes.push(input); return { txStatus: 'TX_STATUS_SUCCESS' } }
  const requests: { url: string; headers: Record<string, string[]> }[] = []
  const http = HttpActionsMock.testInstance()
  http.sendRequest = (req) => {
    const headers: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(req.multiHeaders ?? {})) headers[k] = [...v.values]
    requests.push({ url: req.url, headers })
    return { statusCode: o.status ?? 200, body: Buffer.from(o.body ?? '{"event":{"status":"FINAL","home":3}}').toString('base64') }
  }
  const runtime = newTestRuntime(o.secrets ?? null, {}, o.cfg ?? sample)
  const out = onDryRun(runtime as any, create(CRON_TRIGGER_PB.PayloadSchema, {}))
  return { out, writes, requests }
}

const withFeed = (feed: Partial<Cfg['feed']>, rest: Partial<Cfg> = {}): Cfg => ({ ...sample, ...rest, feed: { ...sample.feed, ...feed } })

test('a finished event over the target prints YES with the value hash, and writes nothing', () => {
  const { out, writes, requests } = run({ body: '{"event":{"status":"FINAL","home":3}}' })
  expect(out).toBe(`YES|${keccak256(toBytes('3'))}|OK`)
  expect(requests.length).toBe(1)
  expect(requests[0].url).toBe('https://api.example-sports.com/v1/events/evt_1')
  expect(writes.length).toBe(0)
})

test('a finished event at or under the target prints NO, and writes nothing', () => {
  const { out, writes } = run({ body: '{"event":{"status":"FINAL","home":2}}' })
  expect(out).toBe(`NO|${keccak256(toBytes('2'))}|OK`)
  expect(writes.length).toBe(0)
})

test('a live event prints NOT_READY, and writes nothing', () => {
  const { out, writes } = run({ body: '{"event":{"status":"LIVE","home":3}}' })
  expect(out).toBe(`NOT_READY|${ZERO32}|NOT_FINAL`)
  expect(writes.length).toBe(0)
})

test('a wrong path prints ERROR, and writes nothing', () => {
  const { out, writes } = run({ cfg: withFeed({ valuePath: 'event.away' }) })
  expect(out).toBe(`ERROR|${ZERO32}|VALUE_MISSING`)
  expect(writes.length).toBe(0)
})

test('HTTP 429, 5xx and invalid JSON print ERROR, and write nothing', () => {
  for (const [body, status, code] of [
    ['{}', 429, 'HTTP_429'],
    ['{}', 503, 'HTTP_503'],
    ['{"event":', 200, 'INVALID_JSON'],
  ] as const) {
    const { out, writes } = run({ body, status })
    expect(out).toBe(`ERROR|${ZERO32}|${code}`)
    expect(writes.length).toBe(0)
  }
})

test('a host not first on the allow-list or an unknown authRef prints ERROR and fetches nothing', () => {
  for (const [cfg, code] of [
    [withFeed({}, { allowList: ['stats.example-data.org', 'api.example-sports.com'] }), 'HOST_NOT_ALLOWED'],
    [withFeed({ authRef: keccak256(toBytes('UNLISTED_PROVIDER')) }), 'UNKNOWN_AUTH_REF'],
    [withFeed({ urlTemplate: 'http://api.example-sports.com/v1/events/{id}' }), 'BAD_URL'],
  ] as const) {
    const { out, writes, requests } = run({ cfg })
    expect(out).toBe(`ERROR|${ZERO32}|${code}`)
    expect(requests.length).toBe(0)
    expect(writes.length).toBe(0)
  }
})

test('a known authRef sends its secret in the configured header', () => {
  const authRef = sample.authSecrets[0].authRef
  const { out, requests } = run({
    cfg: withFeed({ authRef }),
    secrets: new Map([['main', new Map([['SPORTSDATA_API_KEY', 'k-123']])]]),
  })
  expect(out.startsWith('YES|')).toBe(true)
  expect(requests[0].headers['x-api-key']).toEqual(['k-123'])
})

test('the dry-run has no EVM client and calls no write (source check)', async () => {
  const src = await Bun.file(new URL('./main.ts', import.meta.url)).text()
  expect(src).not.toContain('EVMClient')
  expect(src).not.toContain('writeReport')
  expect(src).not.toContain('.report(')
})

test('dry-run and resolution build their node-mode fetch from the same shared function', async () => {
  const shared = /export const fetchAndEvaluate = (nodeFetch<HTTPResponse>\(.*\))\n/
  const mine = shared.exec(await Bun.file(new URL('./main.ts', import.meta.url)).text())?.[1]
  const theirs = shared.exec(await Bun.file(new URL('../resolution/main.ts', import.meta.url)).text())?.[1]
  expect(mine).toBeDefined()
  expect(mine).toBe(theirs)
})
