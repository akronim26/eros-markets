// Task O35.4 setup: `bun src/main.ts` runs the watchdog (plan §9.2, §12.7). It is meant to run apart from the keeper and
// the panel runner (its own machine, RPC endpoint and keys); configuration from the environment, keys are testnet-only
// hot keys (ADJ-38), never in git.
//
//   NETWORK               deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL               the watchdog's own RPC endpoint
//   WATCHDOG_PRIVATE_KEY  the trust set's watchdog key (heartbeat, disputes)
//   WATCHDOG_MODEL        the fourth model (default groq:qwen/qwen3.8-27b@2026-10-03) and its provider's key (oracle-sdk KEYS)
//   SNAPSHOT_DIR          where `eros-snapshot:` snapshots are read (default ./snapshots, ADJ-41)
//   FALLBACKS             optional JSON file {marketId: FeedSpec} of fallback sources (ADJ-44)
//   FEED_AUTH             optional JSON file {authRef: {header, env}}: the header and the variable holding its value
//   PAGER_WEBHOOK         optional URL a page is POSTed to as JSON (else pages go to stderr)
//   POLL_MS               tick interval (default 15000); FROM_BLOCK where log reads start (default the deploy block)
import { loadDeployments, loadGas } from '@eros-oracle/oracle-sdk'
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

const watchdog = new Watchdog({
  chain: viemWatchdogChain({ rpcUrl: env.RPC_URL, watchdogKey: env.WATCHDOG_PRIVATE_KEY as Hex, deployments: loadDeployments(env.NETWORK), fromBlock: env.FROM_BLOCK }),
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
log('info', 'watchdog started', { network: env.NETWORK, model: env.WATCHDOG_MODEL })
await watchdog.run(env.POLL_MS, stop.signal)
