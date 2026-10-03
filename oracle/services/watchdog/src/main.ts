// Runs the watchdog. Run it apart from the keeper and panel runner, with its own machine, RPC endpoint and keys.
//
//   NETWORK                 deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL                 the watchdog's own RPC endpoint
//   WATCHDOG_PRIVATE_KEY    the trust set's watchdog key
//   WATCHDOG_MODEL          default groq:qwen/qwen3.8-27b@2026-10-03; needs its provider's key
//   SNAPSHOT_DIR            where `eros-snapshot:` snapshots are read (default ./snapshots)
//   FALLBACKS               optional JSON file {marketId: FeedSpec}
//   FEED_AUTH               optional JSON file {authRef: {header, env}}
//   PAGER_WEBHOOK           optional URL pages are POSTed to (else stderr)
//   POLL_MS                 tick interval (default 15000)
//   FROM_BLOCK              where intake starts (default the deploy block)
//   INDEXER_URL             Envio GraphQL; logs are read only when it is down or behind (logs only if unset)
//   INDEXER_MAX_LAG_BLOCKS  how far the indexer may trail the head before falling back (default 300)
import { IndexerClient, loadDeployments, loadGas } from '@eros-oracle/oracle-sdk'
import { existsSync, readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { z } from 'zod'
import { viemWatchdogChain } from './chain'
import { snapshotLoader, WATCHDOG_MODEL } from './model'
import type { Page } from './types'
import { Watchdog } from './watchdog'

const env = z
  .object({
    NETWORK: z.string().default('monad-testnet'),
    RPC_URL: z.url(),
    WATCHDOG_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    WATCHDOG_MODEL: z.string().default(WATCHDOG_MODEL),
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

const deployments = loadDeployments(env.NETWORK)
const indexer = env.INDEXER_URL ? { client: new IndexerClient(env.INDEXER_URL, deployments.chainId), maxLagBlocks: env.INDEXER_MAX_LAG_BLOCKS, log } : undefined
const watchdog = new Watchdog({
  chain: viemWatchdogChain({ rpcUrl: env.RPC_URL, watchdogKey: env.WATCHDOG_PRIVATE_KEY as Hex, deployments, fromBlock: env.FROM_BLOCK, indexer }),
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
  model: { model: env.WATCHDOG_MODEL, loadSnapshot: snapshotLoader({ dir: env.SNAPSHOT_DIR }) },
  log,
})
const stop = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop.abort())
log('info', 'watchdog started', { network: env.NETWORK, model: env.WATCHDOG_MODEL, intake: indexer ? 'indexer' : 'oracle logs' })
await watchdog.run(env.POLL_MS, stop.signal)
