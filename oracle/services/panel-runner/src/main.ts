// Runs the panel runner. Keys are testnet-only hot keys.
//
//   NETWORK              deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL              the runner's RPC endpoint
//   RELAYER_PRIVATE_KEY  sends submitPanelResult (pays gas, trusted for nothing)
//   ATTESTOR_PRIVATE_KEY the trust set's runner attestor, which signs PanelResults
//   PANEL_MODELS         "provider:model-id@version", comma-separated; the panel (ADJ-49):
//                        groq:openai/gpt-oss-120b@2026-10-03,nvidia:moonshotai/kimi-k3@2026-10-03,aicredits:anthropic/claude-sonnet-5.5@2026-10-04
//   <PROVIDER>_API_KEY   one per provider (oracle-sdk KEYS); GROQ_API_KEY also runs the injection classifier
//   CALIBRATION          JSON file of calibration maps (default: the placeholder maps)
//   SOURCES              optional JSON file {marketId: [page URLs]}
//   SNAPSHOT_DIR         default ./snapshots
//   POLL_MS              tick interval (default 30000)
//   FROM_BLOCK           where the StateChanged scan starts (default the oracle's deploy block)
import { loadDeployments, loadGas } from '@eros-oracle/oracle-sdk'
import { takeSnapshot } from '@eros-oracle/snapshotter'
import { existsSync, readFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { z } from 'zod'
import { type CalibrationMap, placeholderMaps } from './calibration'
import { viemPanelChain } from './chain'
import { scanSnapshot } from './injection'
import { askPanel } from './models'
import { loadPrompts } from './prompts'
import { PanelRunner } from './runner'
import { signerFromEnv } from './signer'

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const env = z
  .object({
    NETWORK: z.string().default('monad-testnet'),
    RPC_URL: z.url(),
    RELAYER_PRIVATE_KEY: key,
    ATTESTOR_PRIVATE_KEY: key,
    PANEL_MODELS: z.string().min(1),
    CALIBRATION: z.string().optional(),
    SOURCES: z.string().optional(),
    SNAPSHOT_DIR: z.string().default('snapshots'),
    POLL_MS: z.coerce.number().int().positive().default(30_000),
    FROM_BLOCK: z.coerce.bigint().optional(),
  })
  .parse(process.env)

const log = (level: 'info' | 'warn' | 'error', msg: string, data: Record<string, unknown> = {}) =>
  console[level === 'info' ? 'log' : level](JSON.stringify({ level, msg, ...data }))

const models = env.PANEL_MODELS.split(',').map((m) => m.trim())
const maps: CalibrationMap[] = env.CALIBRATION ? JSON.parse(readFileSync(env.CALIBRATION, 'utf8')) : placeholderMaps(models)
const sources: Record<string, string[]> = env.SOURCES && existsSync(env.SOURCES) ? JSON.parse(readFileSync(env.SOURCES, 'utf8')) : {}
const runner = new PanelRunner({
  chain: viemPanelChain({ rpcUrl: env.RPC_URL, relayerKey: env.RELAYER_PRIVATE_KEY as Hex, deployments: loadDeployments(env.NETWORK), fromBlock: env.FROM_BLOCK }),
  signer: signerFromEnv(),
  prompts: loadPrompts(),
  models,
  maps,
  gas: loadGas(),
  takeSnapshot: (req) => takeSnapshot(req),
  scan: (s, p) => scanSnapshot(s, p),
  askPanel: (m, call, items) => askPanel(m, call, items),
  pagesFor: (id) => sources[id.toLowerCase()] ?? [],
  snapshotDir: env.SNAPSHOT_DIR,
  log,
})
const stop = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop.abort())
log('info', 'panel runner started', { network: env.NETWORK, models })
await runner.run(env.POLL_MS, stop.signal)
