// Task O21.3: the handler with the CRE SDK test runtime (plan §11.2, Appendix B.3). B.3's three tests as
// given, then the cases §11.2 and O21.3 add: unknown authRef, specHash mismatch and state != L1Pending write
// nothing (and fetch nothing), a NO report, a known authRef sends its secret header, a host not first on the
// allow-list, 5xx and invalid JSON write nothing.
import { expect } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { addContractMock, EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { getNetwork } from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
const { LogSchema } = EVM_PB
import { decodeAbiParameters, encodeAbiParameters, type Hex, hexToBytes, keccak256, parseAbi, parseAbiParameters, toBytes } from 'viem'
import { onResolutionRequested } from './main'

const ORACLE = '0x00000000000000000000000000000000000000AA' as const
const MARKET = keccak256(toBytes('market-1'))
const ABI = parseAbi([
  'function getL1Job(bytes32 marketId) view returns (uint8 state, (string urlTemplate,string urlParam,bytes32 authRef,string finalPath,string finalValue,string valuePath,uint8 valueType,uint8 decimals,uint8 op,string target,uint32 bufferSecs,uint32 l1TimeoutSecs) spec, string[] allowList, bytes32 specHash)',
])
const spec = {
  urlTemplate: 'https://api.example-sports.com/v1/events/{id}', urlParam: 'evt_1', authRef: ('0x' + '00'.repeat(32)) as Hex,
  finalPath: 'event.status', finalValue: 'FINAL', valuePath: 'event.home', valueType: 1, decimals: 0, op: 2, target: '2',
  bufferSecs: 900, l1TimeoutSecs: 21600,
}
const hashOf = (s: typeof spec) => keccak256(encodeAbiParameters(
  parseAbiParameters('(string,string,bytes32,string,string,string,uint8,uint8,uint8,string,uint32,uint32)'),
  [[s.urlTemplate, s.urlParam, s.authRef, s.finalPath, s.finalValue, s.valuePath, s.valueType,
    s.decimals, s.op, s.target, s.bufferSecs, s.l1TimeoutSecs]],
))
const specHash = hashOf(spec)
const config = { chainSelectorName: 'monad-testnet' as const, isTestnet: true, oracle: ORACLE, writeGasLimit: '400000', httpTimeout: '8s', authSecrets: [] }

function setup(body: string, status = 200) {
  const net = getNetwork({ chainFamily: 'evm', chainSelectorName: 'monad-testnet', isTestnet: true })!
  const evm = EvmMock.testInstance(net.chainSelector.selector)
  const oracle = addContractMock(evm, { address: ORACLE, abi: ABI })
  oracle.getL1Job = () => [3, spec, ['api.example-sports.com'], specHash]
  const writes: Uint8Array[] = []
  oracle.writeReport = (input) => { writes.push(input.report.rawReport); return { txStatus: 'TX_STATUS_SUCCESS' } }
  const http = HttpActionsMock.testInstance()
  http.sendRequest = () => ({ statusCode: status, body: Buffer.from(body).toString('base64') })
  const log = create(LogSchema, {
    address: hexToBytes(ORACLE),
    topics: [hexToBytes(keccak256(toBytes('ResolutionRequested(bytes32,uint64,uint32)'))), hexToBytes(MARKET)],
    data: hexToBytes(encodeAbiParameters(parseAbiParameters('uint64, uint32'), [1_800_000_000n, 1])),
  })
  return { writes, log, runtime: newTestRuntime(null, {}, config) }
}

test('final YES writes a v1 report bound to chain, oracle, market, observedAt', () => {
  const { writes, log, runtime } = setup('{"event":{"status":"FINAL","home":3}}')
  const out = onResolutionRequested(runtime as any, log)
  expect(out.startsWith('proposed:')).toBe(true)
  expect(writes.length).toBe(1)
  const raw = writes[0]
  const body = ('0x' + Buffer.from(raw.slice(109)).toString('hex')) as Hex // strip 109-byte metadata header
  const [v, sel, oracle, market, outcome, observedAt, valueHash, sh] = decodeAbiParameters(
    parseAbiParameters('uint8, uint64, address, bytes32, uint8, uint64, bytes32, bytes32'), body)
  expect(v).toBe(1)
  expect(sel).toBe(2183018362218727504n)
  expect(oracle.toLowerCase()).toBe(ORACLE.toLowerCase())
  expect(market).toBe(MARKET)
  expect(outcome).toBe(1)
  expect(observedAt).toBe(1_800_000_000n)
  expect(valueHash).toBe(keccak256(toBytes('3')))
  expect(sh).toBe(specHash)
})

test('live event writes nothing', () => {
  const { writes, log, runtime } = setup('{"event":{"status":"LIVE","home":3}}')
  expect(onResolutionRequested(runtime as any, log).startsWith('nowrite:')).toBe(true)
  expect(writes.length).toBe(0)
})

test('HTTP 429 writes nothing', () => {
  const { writes, log, runtime } = setup('{}', 429)
  expect(onResolutionRequested(runtime as any, log).startsWith('nowrite:')).toBe(true)
  expect(writes.length).toBe(0)
})

// ---------------------------------------------------------------- O21.3 additions

type Opts = {
  body?: string
  status?: number
  state?: number
  spec?: typeof spec
  onchainHash?: Hex
  allowList?: string[]
  authSecrets?: { authRef: string; secretId: string; header: string; prefix: string }[]
  secrets?: Map<string, Map<string, string>>
}

/** As B.3's `setup`, with every input of the read and the config settable, recording each HTTP request. */
function setupWith(o: Opts) {
  const s = o.spec ?? spec
  const net = getNetwork({ chainFamily: 'evm', chainSelectorName: 'monad-testnet', isTestnet: true })!
  const evm = EvmMock.testInstance(net.chainSelector.selector)
  const oracle = addContractMock(evm, { address: ORACLE, abi: ABI })
  oracle.getL1Job = () => [o.state ?? 3, s, o.allowList ?? ['api.example-sports.com'], o.onchainHash ?? hashOf(s)]
  const writes: Uint8Array[] = []
  oracle.writeReport = (input) => { writes.push(input.report.rawReport); return { txStatus: 'TX_STATUS_SUCCESS' } }
  const requests: { url: string; headers: Record<string, string[]> }[] = []
  const http = HttpActionsMock.testInstance()
  http.sendRequest = (req) => {
    const headers: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(req.multiHeaders ?? {})) headers[k] = [...v.values]
    requests.push({ url: req.url, headers })
    return { statusCode: o.status ?? 200, body: Buffer.from(o.body ?? '{"event":{"status":"FINAL","home":3}}').toString('base64') }
  }
  const log = create(LogSchema, {
    address: hexToBytes(ORACLE),
    topics: [hexToBytes(keccak256(toBytes('ResolutionRequested(bytes32,uint64,uint32)'))), hexToBytes(MARKET)],
    data: hexToBytes(encodeAbiParameters(parseAbiParameters('uint64, uint32'), [1_800_000_000n, 1])),
  })
  const cfg = { ...config, authSecrets: o.authSecrets ?? [] }
  return { writes, requests, log, runtime: newTestRuntime(o.secrets ?? null, {}, cfg) }
}

const decodeReport = (raw: Uint8Array) =>
  decodeAbiParameters(
    parseAbiParameters('uint8, uint64, address, bytes32, uint8, uint64, bytes32, bytes32'),
    ('0x' + Buffer.from(raw.slice(109)).toString('hex')) as Hex,
  )

test('final NO writes outcome 2 with the value hash of the lexeme', () => {
  const { writes, log, runtime } = setupWith({ body: '{"event":{"status":"FINAL","home":2}}' })
  expect(onResolutionRequested(runtime as any, log).startsWith('proposed:')).toBe(true)
  expect(writes.length).toBe(1)
  const [, , , market, outcome, , valueHash, sh] = decodeReport(writes[0])
  expect(market).toBe(MARKET)
  expect(outcome).toBe(2)
  expect(valueHash).toBe(keccak256(toBytes('2')))
  expect(sh).toBe(specHash)
})

test('state != L1Pending writes nothing and fetches nothing', () => {
  for (const state of [0, 4, 7, 10]) {
    const { writes, requests, log, runtime } = setupWith({ state })
    expect(onResolutionRequested(runtime as any, log)).toBe(`skip:${MARKET}:state=${state}`)
    expect(writes.length).toBe(0)
    expect(requests.length).toBe(0)
  }
})

test('specHash mismatch writes nothing and fetches nothing', () => {
  const { writes, requests, log, runtime } = setupWith({ onchainHash: keccak256(toBytes('another spec')) })
  expect(onResolutionRequested(runtime as any, log)).toBe(`error:${MARKET}:SPEC_HASH_MISMATCH`)
  expect(writes.length).toBe(0)
  expect(requests.length).toBe(0)
})

test('unknown authRef writes nothing and fetches nothing', () => {
  const withAuth = { ...spec, authRef: keccak256(toBytes('UNLISTED_PROVIDER')) }
  const { writes, requests, log, runtime } = setupWith({ spec: withAuth })
  expect(onResolutionRequested(runtime as any, log)).toBe(`error:${MARKET}:UNKNOWN_AUTH_REF`)
  expect(writes.length).toBe(0)
  expect(requests.length).toBe(0)
})

test('a known authRef sends its secret in the configured header (prefix included)', () => {
  const authRef = keccak256(toBytes('SPORTSDATA_V1'))
  const { writes, requests, log, runtime } = setupWith({
    spec: { ...spec, authRef },
    authSecrets: [{ authRef, secretId: 'SPORTSDATA_API_KEY', header: 'x-api-key', prefix: 'Key ' }],
    secrets: new Map([['main', new Map([['SPORTSDATA_API_KEY', 'k-123']])]]),
  })
  expect(onResolutionRequested(runtime as any, log).startsWith('proposed:')).toBe(true)
  expect(writes.length).toBe(1)
  expect(requests.length).toBe(1)
  expect(requests[0].url).toBe('https://api.example-sports.com/v1/events/evt_1')
  expect(requests[0].headers['x-api-key']).toEqual(['Key k-123'])
})

test('a host that is not first on the allow-list writes nothing and fetches nothing', () => {
  const { writes, requests, log, runtime } = setupWith({ allowList: ['stats.example-data.org', 'api.example-sports.com'] })
  expect(onResolutionRequested(runtime as any, log)).toBe(`error:${MARKET}:HOST_NOT_ALLOWED`)
  expect(writes.length).toBe(0)
  expect(requests.length).toBe(0)
})

test('HTTP 5xx and invalid JSON write nothing', () => {
  for (const [body, status, code] of [
    ['{}', 503, 'HTTP_503'],
    ['{"event":', 200, 'INVALID_JSON'],
  ] as const) {
    const { writes, log, runtime } = setupWith({ body, status })
    expect(onResolutionRequested(runtime as any, log)).toBe(`nowrite:${MARKET}:ERROR:${code}`)
    expect(writes.length).toBe(0)
  }
})
