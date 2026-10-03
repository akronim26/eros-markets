// Task O33.5: `bun src/main.ts` runs the panel runner (plan §8.3, §12.7). Configuration from the environment; keys are
// testnet-only hot keys (ADJ-38, ADJ-42), never in git.
//
//   NETWORK              deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL              the runner's RPC endpoint
//   RELAYER_PRIVATE_KEY  the EOA that sends submitPanelResult (pays gas; trusted for nothing)
//   ATTESTOR_PRIVATE_KEY the trust set's runner attestor (signs PanelResults)
//   PANEL_MODELS         the configured models, "provider:model-id@version", comma-separated
//   GROQ_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY, …  the providers' keys (oracle-sdk KEYS); GROQ_API_KEY also runs
//                        the injection classifier
//   CALIBRATION          a JSON file of calibration maps (default: the placeholder maps, ADJ: O33.3)
//   SOURCES              a JSON file {marketId: [page URLs]} of configured evidence pages (optional)
//   SNAPSHOT_DIR         where snapshots are kept (default ./snapshots, ADJ-41)
//   POLL_MS              tick interval (default 30000)
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
  })
  .parse(process.env)

const log = (level: 'info' | 'warn' | 'error', msg: string, data: Record<string, unknown> = {}) =>
  console[level === 'info' ? 'log' : level](JSON.stringify({ level, msg, ...data }))

const models = env.PANEL_MODELS.split(',').map((m) => m.trim())
const maps: CalibrationMap[] = env.CALIBRATION ? JSON.parse(readFileSync(env.CALIBRATION, 'utf8')) : placeholderMaps(models)
const sources: Record<string, string[]> = env.SOURCES && existsSync(env.SOURCES) ? JSON.parse(readFileSync(env.SOURCES, 'utf8')) : {}
const runner = new PanelRunner({
  chain: viemPanelChain({ rpcUrl: env.RPC_URL, relayerKey: env.RELAYER_PRIVATE_KEY as Hex, deployments: loadDeployments(env.NETWORK) }),
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
