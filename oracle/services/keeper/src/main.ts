// Task O31.1: `bun src/main.ts` runs one keeper instance (plan §9.1, §12.7). Configuration comes from the
// environment; the key comes from the secret manager in production and from deployments/testnet-keys.env on
// testnet (ADJ-38), never from git.
//
//   NETWORK            deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL            the instance's own RPC endpoint
//   KEEPER_PRIVATE_KEY the instance's sending key
//   INDEXER_URL        Envio GraphQL; without it the registry's MarketListed logs are scanned
//   POLL_MS            tick interval (default 15000)
//   DELAY_MS           offset of the second instance between planning and sending (default 0)
import { loadDeployments, loadGas } from '@eros-oracle/oracle-sdk'
import { createPublicClient, http, type Hex } from 'viem'
import { z } from 'zod'
import { viemChain } from './chain'
import { PLANNERS } from './jobs'
import { Keeper } from './keeper'
import { IndexerSource, RegistryLogSource } from './sources'
import type { Logger, MarketSource } from './types'

const env = z
  .object({
    NETWORK: z.string().default('monad-testnet'),
    RPC_URL: z.url(),
    KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    INDEXER_URL: z.url().optional(),
    POLL_MS: z.coerce.number().int().positive().default(15_000),
    DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  })
  .parse(process.env)

const log: Logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
}

const deployments = loadDeployments(env.NETWORK)
const chain = viemChain({ rpcUrl: env.RPC_URL, privateKey: env.KEEPER_PRIVATE_KEY as Hex, deployments })
const registry = deployments.contracts.MarketRegistry
const source: MarketSource = env.INDEXER_URL
  ? new IndexerSource(env.INDEXER_URL)
  : new RegistryLogSource(createPublicClient({ transport: http(env.RPC_URL) }), registry.address, BigInt(registry.deployBlock))

const keeper = new Keeper({ chain, source, planners: PLANNERS, gas: loadGas(), delayMs: env.DELAY_MS, log })
const stop = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop.abort())
log.info('keeper started', { network: env.NETWORK, planners: PLANNERS.length, source: env.INDEXER_URL ? 'indexer' : 'registry logs' })
await keeper.run(env.POLL_MS, stop.signal)
