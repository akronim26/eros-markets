// Listing dry-run workflow, for simulation only. It runs the resolution workflow's checks, fetch and evaluator on a
// candidate FeedSpec from config, prints "STATUS|valueHash|code", and has no EVM client, so it writes nothing.
import {
  consensusIdenticalAggregation,
  cre,
  type CronPayload,
  handler,
  type HTTPSendRequester,
  Runner,
  type Runtime,
  text,
} from '@chainlink/cre-sdk'
import { keccak256, toBytes } from 'viem'
import { z } from 'zod'
import { allowListed, buildUrl, type FeedSpec } from '../../packages/feedspec/src/index'
import { nodeFetch, ZERO32 } from '../../packages/feedspec/src/fetch'

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const uint32 = z.number().int().min(0).max(0xffffffff)
const configSchema = z.object({
  schedule: z.string(), // the cron trigger only starts the run; simulate fires it once
  httpTimeout: z.string().regex(/^[0-9]+s$/), // max "10s"
  allowList: z.array(z.string()).min(1), // host of urlTemplate first
  authSecrets: z.array(z.object({ authRef: hex32, secretId: z.string(), header: z.string(), prefix: z.string() })),
  feed: z.object({
    urlTemplate: z.string(),
    urlParam: z.string(),
    authRef: hex32,
    finalPath: z.string(),
    finalValue: z.string(),
    valuePath: z.string(),
    valueType: z.number().int().min(0).max(2),
    decimals: z.number().int().min(0).max(255),
    op: z.number().int().min(0).max(5),
    target: z.string(),
    bufferSecs: uint32,
    l1TimeoutSecs: uint32,
  }),
})
type Config = z.infer<typeof configSchema>

type HTTPResponse = ReturnType<ReturnType<HTTPSendRequester['sendRequest']>['result']>
export const fetchAndEvaluate = nodeFetch<HTTPResponse>({ text: (r) => text(r), hashLexeme: (l) => keccak256(toBytes(l)) })

const error = (code: string) => `ERROR|${ZERO32}|${code}`

export const onDryRun = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  const cfg = runtime.config
  const spec: FeedSpec = { ...cfg.feed }

  // The resolution workflow's checks, in its order, after its specHash check.
  let url: string
  try { url = buildUrl(spec) } catch { return error('BAD_URL') }
  if (!allowListed(url, cfg.allowList)) return error('HOST_NOT_ALLOWED')

  let authHeader = ''
  let authValue = ''
  if (spec.authRef !== ZERO32) {
    const entry = cfg.authSecrets.find((a) => a.authRef.toLowerCase() === spec.authRef.toLowerCase())
    if (!entry) return error('UNKNOWN_AUTH_REF')
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
    return error('NO_CONSENSUS')
  }
  runtime.log(`dryrun ${url}: ${agreed}`)
  return agreed
}

const initWorkflow = (config: Config) => [
  handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onDryRun),
]

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
