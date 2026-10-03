// `oracle-cli list` (plan §12.9 steps 2 and 6, O22.2): from a listing input, writes listings/<marketId>/ with
// pack.json (the createMarket arguments in ListMarket's schema), reference.json (the captured response of a
// finished event; its keccak256 is dryRunHash) and claim.txt (rendered by ClaimRenderer). Before writing, it
// checks the FeedSpec with the evaluator package, that the reference evaluates to YES or NO, the claim length
// against maxClaimBytes, and createMarket itself in a Foundry dry-run (CheckPack). Any failure throws and
// writes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildUrl, evaluateResponse, type FeedSpec, MAX_BODY_BYTES, validateSpec } from '@eros-oracle/feedspec'
import { BadFeed } from '@eros-oracle/feedspec'
import { getAddress, type Hex, keccak256, toBytes } from 'viem'
import { checkPack, ORACLE_ROOT, renderClaim } from './forge'
import { type Listing, listingSchema, stringify } from './schema'

export const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export class ListError extends Error {}

export type ListOptions = {
  input: string // path of the listing input (schema.ts)
  network?: string // params.<network>.json and deployments/<network>.json; default monad-testnet
  referenceFile?: string // a captured response to use instead of fetching the reference URL
  out?: string // default <oracle>/listings
  oracle?: string // claim binding; default deployments/<network>.json
  chainId?: bigint // claim binding; default params.<network>.json
  check?: boolean // run the createMarket dry-run (default true)
  now?: bigint // listing time for the dry-run; default the wall clock
  providers?: string[] // hosts assumed on the global provider list in the dry-run (params.providers is empty until X03/X04)
  force?: boolean // replace an existing pack directory
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

export type ListResult = {
  marketId: Hex
  dir: string
  dryRunHash: Hex
  reference: { url: string; status: string; valueHash: Hex }
  claimBytes: number
  worstCase: bigint
  maxClaimBytes: number
  check?: string
}

export const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

/** The listing input, validated against the schema (ListError on any issue). */
export function readListing(path: string): Listing {
  const parsed = listingSchema.safeParse(readJson(path))
  if (!parsed.success) throw new ListError(`bad listing input: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

export const readParams = (network: string) => readJson(join(ORACLE_ROOT, 'deployments', `params.${network}.json`))

/** listings/<marketId>/ for a listing input (marketId = keccak256 of the slug). */
export const packDir = (input: Listing, out?: string) => join(out ?? join(ORACLE_ROOT, 'listings'), keccak256(toBytes(input.slug)))

export async function list(o: ListOptions): Promise<ListResult> {
  const network = o.network ?? 'monad-testnet'
  const input = readListing(o.input)
  const paramsPath = join('deployments', `params.${network}.json`)
  const params = readParams(network)
  const g = params.globals
  const m = input.marketInput
  const feed: FeedSpec = { ...m.feed }

  // Rule 3 offline first (the evaluator package's mirror of FeedSpecLib), for a readable error.
  const authRefKnown = feed.authRef === ZERO32 || (params.authRefs as string[]).some((r) => keccak256(toBytes(r)) === feed.authRef.toLowerCase())
  const code = validateSpec(feed, m.allowList[0], authRefKnown, g)
  if (code !== BadFeed.OK) {
    const name = Object.entries(BadFeed).find(([, v]) => v === code)?.[0]
    throw new ListError(`BadFeed(${code}) ${name}: the FeedSpec fails createMarket rule 3`)
  }

  // Step 2: the reference response, which must be a finished event (YES or NO).
  const refSpec = { ...feed, urlParam: input.reference.urlParam }
  const refUrl = buildUrl(refSpec)
  const body = o.referenceFile ? new Uint8Array(readFileSync(o.referenceFile)) : await fetchReference(refUrl, feed.authRef, network, o)
  if (body.length > MAX_BODY_BYTES) throw new ListError(`reference is ${body.length} bytes, above ${MAX_BODY_BYTES}`)
  const ev = evaluateResponse(refSpec, 200, new TextDecoder('utf-8').decode(body).trim(), body.length)
  if (ev.status !== 'YES' && ev.status !== 'NO') {
    throw new ListError(`reference evaluates to ${ev.status} (${ev.code}), not YES or NO: it must be a finished event (§12.9 step 2)`)
  }
  const valueHash = keccak256(toBytes(ev.valueLexeme))
  const dryRunHash = keccak256(body)
  const marketId = keccak256(toBytes(input.slug))

  const pack = {
    _note: `Listing pack written by oracle-cli list (O22.2) for slug "${input.slug}". reference.json: ${refUrl} (${ev.status}, value ${ev.valueLexeme}). ambiguityLogHash stays zero until the ambiguity pass (O22.3).`,
    marketInput: {
      marketId,
      question: m.question,
      rules: m.rules,
      claimTemplate: m.claimTemplate,
      windowStart: m.windowStart,
      windowEnd: m.windowEnd,
      tau: m.tau,
      groupId: m.groupId,
      groupExclusive: m.groupExclusive,
      hasFeed: m.hasFeed,
      feed: m.feed,
      allowList: m.allowList,
      ai: m.ai,
      uma: m.uma,
      l2DeadlineSecs: m.l2DeadlineSecs,
      voidSecs: m.voidSecs,
      monitor: m.monitor,
      oiCapLots: m.oiCapLots,
      dryRunHash,
      ambiguityLogHash: ZERO32,
    },
    engineListing: input.engineListing,
    engineInit: input.engineInit,
  }
  const packJson = stringify(pack)

  // Step 6: the claim a Layer 1 YES proposal would assert, and the registry's length bound.
  const { claim, worstCase } = renderClaim(
    m.claimTemplate,
    {
      marketId, chainId: o.chainId ?? BigInt(params.chainId), oracle: claimOracle(network, o), question: m.question,
      rules: m.rules, tau: m.tau, outcome: 1, evidenceHash: ZERO32, // the report's hash exists only once the report does
    },
    buildUrl(feed),
    valueHash,
  )
  const maxClaimBytes = Number(g.maxClaimBytes)
  if (worstCase > BigInt(maxClaimBytes)) throw new ListError(`ClaimTooLong: worst case ${worstCase} bytes > maxClaimBytes ${maxClaimBytes} (rule 6)`)
  if (claim.length > maxClaimBytes) throw new ListError(`ClaimTooLong: ${claim.length} bytes > maxClaimBytes ${maxClaimBytes}`)

  // createMarket in a Foundry dry-run: every registry rule, applied by the contracts.
  const check = o.check === false ? undefined : checkPack(packJson, { params: paramsPath, now: o.now, providers: o.providers })

  const dir = packDir(input, o.out)
  if (existsSync(dir) && !o.force) throw new ListError(`${dir} exists (pass --force to replace it)`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pack.json'), packJson)
  writeFileSync(join(dir, 'reference.json'), body)
  writeFileSync(join(dir, 'claim.txt'), claim)
  return {
    marketId, dir, dryRunHash, reference: { url: refUrl, status: ev.status, valueHash },
    claimBytes: claim.length, worstCase, maxClaimBytes, check,
  }
}

/** The oracle address the claim names: --oracle, else the deployment of the network. */
function claimOracle(network: string, o: ListOptions): Hex {
  if (o.oracle) return getAddress(o.oracle)
  const path = join(ORACLE_ROOT, 'deployments', `${network}.json`)
  if (!existsSync(path)) throw new ListError(`no deployments/${network}.json: pass --oracle <address> for the claim preview`)
  return getAddress(readJson(path).contracts.ResolutionOracle.address)
}

/** The headers a DON node sends: accept, plus the authRef's secret from the workflow config (§7.4). */
export function nodeHeaders(authRef: string, network: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (authRef === ZERO32) return headers
  const entry = authSecretsFor(network).find((a) => a.authRef.toLowerCase() === authRef.toLowerCase())
  if (!entry) throw new ListError(`authRef ${authRef} is not in workflows/resolution/${workflowConfigName(network)}`)
  const secrets = Bun.YAML.parse(readFileSync(join(ORACLE_ROOT, 'workflows', 'secrets.yaml'), 'utf8')) as {
    secretsNames: Record<string, string[]>
  }
  const envVar = secrets.secretsNames[entry.secretId]?.[0]
  const value = envVar ? env[envVar] : undefined
  if (!value) throw new ListError(`set ${envVar ?? entry.secretId} (secret ${entry.secretId}) to call the provider`)
  headers[entry.header] = entry.prefix + value
  return headers
}

export type AuthSecret = { authRef: string; secretId: string; header: string; prefix: string }
const workflowConfigName = (network: string) => `config.${network === 'monad-mainnet' ? 'production' : 'staging'}.json`
/** The resolution workflow's authRef table for the network (the dry-run workflow uses the same one). */
export const authSecretsFor = (network: string): AuthSecret[] =>
  readJson(join(ORACLE_ROOT, 'workflows', 'resolution', workflowConfigName(network))).authSecrets

/** GET the reference URL as a DON node would. */
async function fetchReference(url: string, authRef: string, network: string, o: ListOptions): Promise<Uint8Array> {
  const headers = nodeHeaders(authRef, network, o.env)
  const resp = await (o.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (resp.status !== 200) throw new ListError(`reference fetch: HTTP ${resp.status} from ${url}`)
  return new Uint8Array(await resp.arrayBuffer())
}

export { stringify, type Listing }
