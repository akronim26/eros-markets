// Runs the watchdog. Run it apart from the keeper and panel runner, with its own machine, RPC endpoint and keys.
//
//   NETWORK                 verified frontend manifest (default monad-testnet); DEPLOYMENTS_FILE selects an explicit historical record
//   RPC_URL                 the watchdog's own RPC endpoint
//   WATCHDOG_PRIVATE_KEY    the trust set's watchdog key
//   WATCHDOG_MODEL          default google:gemini-3.8-flash@2026-10-03 (GEMINI_API_KEY); needs its provider's key
//   SNAPSHOT_DIR            where `eros-snapshot:` snapshots are read (default ./snapshots)
//   FALLBACKS               optional JSON file {marketId: FeedSpec}
//   FEED_AUTH               optional JSON file {authRef: {header, env}}
//   PAGER_WEBHOOK           optional URL pages are POSTed to (else stderr)
//   POLL_MS                 tick interval (default 15000)
//   FROM_BLOCK              where intake starts (default the deploy block)
//   INDEXER_URL             Envio GraphQL; logs are read only when it is down or behind (logs only if unset)
//   INDEXER_MAX_LAG_BLOCKS  how far the indexer may trail the head before falling back (default 300)
import { IndexerClient, loadServiceDeployment, loadGas } from '@eros-oracle/oracle-sdk'
import { existsSync, readFileSync } from 'node:fs'
import { createPublicClient, http, type Hex } from 'viem'
import { z } from 'zod'
import { viemWatchdogChain } from './chain'
import { snapshotLoader, WATCHDOG_MODEL } from './model'
import type { Page } from './types'
import { Watchdog } from './watchdog'
import { assertLiveness, disputeMargin } from './timing'

const env = z
  .object({
    NETWORK: z.string().default('monad-testnet'),
    DEPLOYMENTS_FILE: z.string().min(1).optional(),
    DEPLOYMENT_MANIFEST: z.string().min(1).optional(),
    RPC_URL: z.url(),
    WATCHDOG_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    WATCHDOG_MODEL: z.string().default(WATCHDOG_MODEL),
    WATCHDOG_TESTNET_DISPUTE_MARGIN_SECS: z.string().optional(),
    SNAPSHOT_DIR: z.string().default('snapshots'),
    FALLBACKS: z.string().optional(),
    FEED_AUTH: z.string().optional(),
    PAGER_WEBHOOK: z.url().optional(),
    POLL_MS: z.coerce.number().int().positive().default(15_000),
    FROM_BLOCK: z.coerce.bigint().optional(),
    INDEXER_URL: z.url().optional(),
    INDEXER_MAX_LAG_BLOCKS: z.coerce.bigint().default(300n),
  })
  .parse(process.env)

const json = (f?: string) => (f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {})
const fallbacks = Object.fromEntries(Object.entries(json(env.FALLBACKS)).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, any>
const feedAuth = json(env.FEED_AUTH) as Record<string, { header: string; env: string }>
const log = (level: 'info' | 'warn' | 'error', msg: string, data: Record<string, unknown> = {}) => console[level === 'info' ? 'log' : level](JSON.stringify({ level, msg, ...data }))
const page: Page = async (e) => {
  console.error(JSON.stringify({ level: 'page', ...e }))
  if (env.PAGER_WEBHOOK) await fetch(env.PAGER_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) }).catch((err) => log('error', 'pager webhook failed', { error: String(err) }))
}

const deployments = loadServiceDeployment(env.NETWORK, { deploymentsFile: env.DEPLOYMENTS_FILE, manifestFile: env.DEPLOYMENT_MANIFEST })
const rpcChainId = await createPublicClient({ transport: http(env.RPC_URL) }).getChainId()
const margin = disputeMargin({ network: env.NETWORK, deploymentChainId: deployments.chainId, rpcChainId, testnetMargin: env.WATCHDOG_TESTNET_DISPUTE_MARGIN_SECS })
const indexer = env.INDEXER_URL ? { client: new IndexerClient(env.INDEXER_URL, deployments.chainId), maxLagBlocks: env.INDEXER_MAX_LAG_BLOCKS, log } : undefined
const chain = viemWatchdogChain({ rpcUrl: env.RPC_URL, watchdogKey: env.WATCHDOG_PRIVATE_KEY as Hex, deployments, fromBlock: env.FROM_BLOCK, indexer })
for (const market of deployments.markets ?? []) assertLiveness(await chain.liveness(market.marketId), margin)
const watchdog = new Watchdog({
  chain,
  disputeMarginSecs: margin,
  gas: loadGas(),
  page,
  l1: {
    fallbacks,
    auth: (ref) => {
      const a = feedAuth[ref.toLowerCase()]
      const value = a ? process.env[a.env] : undefined
      return a && value ? { header: a.header, value } : null
    },
  },
  model: { model: env.WATCHDOG_MODEL, loadSnapshot: snapshotLoader({ dir: env.SNAPSHOT_DIR }),
    ...(env.WATCHDOG_TESTNET_DISPUTE_MARGIN_SECS === undefined ? {} : { timeoutMs: 20_000, maxRetries: 0 }) },
  log,
})
const stop = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop.abort())
log('info', 'watchdog started', { network: env.NETWORK, model: env.WATCHDOG_MODEL, disputeMarginSecs: String(margin), intake: indexer ? 'indexer' : 'oracle logs' })
await watchdog.run(env.POLL_MS, stop.signal)
