// Eros Markets — Layer 1 resolution workflow (Oracle spec §5). One generic workflow for all
// Layer 1 markets; per-market data is read from chain. Writes only YES/NO reports.
import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  type EVMLog,
  getNetwork,
  handler,
  type HTTPSendRequester,
  LAST_FINALIZED_BLOCK_NUMBER,
  logTriggerConfig,
  prepareReportRequest,
  Runner,
  type Runtime,
  text,
  TxStatus,
} from '@chainlink/cre-sdk'
import {
  type Address,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  toHex,
  zeroAddress,
} from 'viem'
import { z } from 'zod'
import { allowListed, buildUrl, evaluateResponse, type FeedSpec, MAX_BODY_BYTES } from '../../packages/feedspec/src/index'

const configSchema = z.object({
  chainSelectorName: z.enum(['monad-testnet', 'monad-mainnet']),
  isTestnet: z.boolean(),
  oracle: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  writeGasLimit: z.string().regex(/^[0-9]+$/),
  httpTimeout: z.string().regex(/^[0-9]+s$/), // max "10s"
  authSecrets: z.array(
    z.object({ authRef: z.string().regex(/^0x[0-9a-fA-F]{64}$/), secretId: z.string(), header: z.string(), prefix: z.string() }),
  ),
})
type Config = z.infer<typeof configSchema>

const RESOLUTION_REQUESTED = keccak256(toBytes('ResolutionRequested(bytes32,uint64,uint32)'))
const ORACLE_ABI = parseAbi([
  'function getL1Job(bytes32 marketId) view returns (uint8 state, (string urlTemplate,string urlParam,bytes32 authRef,string finalPath,string finalValue,string valuePath,uint8 valueType,uint8 decimals,uint8 op,string target,uint32 bufferSecs,uint32 l1TimeoutSecs) spec, string[] allowList, bytes32 specHash)',
])
const FEEDSPEC_PARAMS = parseAbiParameters(
  '(string,string,bytes32,string,string,string,uint8,uint8,uint8,string,uint32,uint32)',
)
const STATE_L1_PENDING = 3 // RState.L1Pending (see OracleTypes.sol)
const ZERO32 = `0x${'00'.repeat(32)}`

// Node mode: each DON node fetches and evaluates independently. Returns "STATUS|valueHash|code".
const fetchAndEvaluate = (
  sendRequester: HTTPSendRequester,
  spec: FeedSpec,
  url: string,
  timeout: string,
  authHeader: string,
  authValue: string,
): string => {
  try {
    const multiHeaders: Record<string, { values: string[] }> = { accept: { values: ['application/json'] } }
    if (authHeader !== '') multiHeaders[authHeader] = { values: [authValue] }
    const resp = sendRequester
      .sendRequest({
        url,
        method: 'GET',
        multiHeaders,
        timeout,
        cacheSettings: { store: false }, // maxAge unset (0) => never read from cache; fresh per node
      })
      .result()
    const bodyBytes = resp.body.length
    if (bodyBytes > MAX_BODY_BYTES) return 'ERROR|' + ZERO32 + '|BODY_TOO_LARGE'
    const ev = evaluateResponse(spec, resp.statusCode, text(resp), bodyBytes)
    const vh = ev.status === 'YES' || ev.status === 'NO' ? keccak256(toBytes(ev.valueLexeme)) : ZERO32
    return `${ev.status}|${vh}|${ev.code}`
  } catch {
    return 'ERROR|' + ZERO32 + '|FETCH_FAILED' // timeout, 429 throttling at transport, >250KB, etc.
  }
}

export const onResolutionRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
  const cfg = runtime.config
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName, isTestnet: cfg.isTestnet })
  if (!network) throw new Error('network not found')
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // 1) Decode the trigger: marketId (topic1), requestedAt (data word 0) = observedAt.
  const marketId = bytesToHex(log.topics[1]) as Hex
  const [requestedAt] = decodeAbiParameters(parseAbiParameters('uint64, uint32'), bytesToHex(log.data) as Hex)

  // 2) Read state + FeedSpec + allow-list in one EVM read at the last finalized block.
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: cfg.oracle as Address,
        data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'getL1Job', args: [marketId] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const [state, s, allowList, specHash] = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: 'getL1Job',
    data: bytesToHex(reply.data) as Hex,
  })
  if (state !== STATE_L1_PENDING) return `skip:${marketId}:state=${state}`

  const spec: FeedSpec = {
    urlTemplate: s.urlTemplate, urlParam: s.urlParam, authRef: s.authRef, finalPath: s.finalPath,
    finalValue: s.finalValue, valuePath: s.valuePath, valueType: s.valueType, decimals: s.decimals,
    op: s.op, target: s.target, bufferSecs: s.bufferSecs, l1TimeoutSecs: s.l1TimeoutSecs,
  }
  const recomputed = keccak256(
    encodeAbiParameters(FEEDSPEC_PARAMS, [[spec.urlTemplate, spec.urlParam, spec.authRef as Hex, spec.finalPath,
      spec.finalValue, spec.valuePath, spec.valueType, spec.decimals, spec.op, spec.target, spec.bufferSecs, spec.l1TimeoutSecs]]),
  )
  if (recomputed !== specHash) return `error:${marketId}:SPEC_HASH_MISMATCH`

  // 3) Allow-list enforced again here (also enforced at createMarket).
  let url: string
  try { url = buildUrl(spec) } catch { return `error:${marketId}:BAD_URL` }
  if (!allowListed(url, allowList as string[])) return `error:${marketId}:HOST_NOT_ALLOWED`

  // 4) Secret (DON mode) for authRef, then node-mode fetch + identical consensus. No withDefault.
  let authHeader = ''
  let authValue = ''
  if (spec.authRef !== ZERO32) {
    const entry = cfg.authSecrets.find((a) => a.authRef.toLowerCase() === spec.authRef.toLowerCase())
    if (!entry) return `error:${marketId}:UNKNOWN_AUTH_REF`
    authHeader = entry.header
    authValue = entry.prefix + runtime.getSecret({ id: entry.secretId }).result().value
  }
  let agreed: string
  try {
    agreed = new cre.capabilities.HTTPClient()
      .sendRequest(runtime, fetchAndEvaluate, consensusIdenticalAggregation<string>())(
        spec, url, cfg.httpTimeout, authHeader, authValue,
      )
      .result()
  } catch {
    return `noconsensus:${marketId}` // failed consensus writes nothing
  }
  const [status, valueHash, code] = agreed.split('|')
  if (status !== 'YES' && status !== 'NO') return `nowrite:${marketId}:${status}:${code}`

  // 5) Report v1 (Oracle spec §5.4 + valueHash/specHash): chain + oracle bound, observedAt = log time.
  const payload = encodeAbiParameters(
    parseAbiParameters('uint8, uint64, address, bytes32, uint8, uint64, bytes32, bytes32'),
    [1, network.chainSelector.selector, cfg.oracle as Address, marketId, status === 'YES' ? 1 : 2,
      requestedAt, valueHash as Hex, specHash],
  )
  const report = runtime.report(prepareReportRequest(payload)).result()
  const wr = evm
    .writeReport(runtime, { receiver: cfg.oracle, report, gasConfig: { gasLimit: cfg.writeGasLimit } })
    .result()
  if (wr.txStatus !== TxStatus.SUCCESS) return `write_failed:${marketId}:${wr.errorMessage ?? ''}`
  return `proposed:${marketId}:${status}:${wr.txHash ? toHex(wr.txHash) : ''}`
}

const initWorkflow = (config: Config) => {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: config.isTestnet })
  if (!network) throw new Error('network not found')
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  return [
    handler(
      evm.logTrigger(
        logTriggerConfig({ addresses: [config.oracle as Hex], topics: [[RESOLUTION_REQUESTED]], confidence: 'FINALIZED' }),
      ),
      onResolutionRequested,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
