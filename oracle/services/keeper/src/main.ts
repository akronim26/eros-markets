// Runs one keeper instance. The key comes from a secret manager (production) or deployments/testnet-keys.env.
//
//   NETWORK                 deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL                 this instance's RPC endpoint
//   KEEPER_PRIVATE_KEY      this instance's sending key
//   INDEXER_URL             Envio GraphQL; RPC logs are read only when it is down or behind (logs only if unset)
//   INDEXER_MAX_LAG_BLOCKS  how far the indexer may trail the head before falling back (default 300)
//   POLL_MS                 tick interval (default 15000)
//   DELAY_MS                planning-to-sending offset for a second instance (default 0)
import { IndexerClient } from '@eros-oracle/oracle-sdk'
import { createPublicClient, http, type Hex } from 'viem'
import { viemChain } from './chain'
import { assertKeeperChain, loadKeeperConfiguration } from './config'
import { globalPlanners, planners } from './jobs'
import { Keeper } from './keeper'
import { indexedDisputes, indexedMarkets, RegistryLogSource, TreasuryDisputeSource } from './sources'
import type { DisputeSource, Logger, MarketSource } from './types'

const { env, deployments, engineIdentities, gas } = loadKeeperConfiguration(process.env)

const log: Logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: 'warn', msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: 'error', msg, ...data })),
}

const registry = deployments.contracts.MarketRegistry
const treasury = deployments.contracts.BondTreasury
const logs = createPublicClient({ transport: http(env.RPC_URL) })
await assertKeeperChain(logs, deployments.chainId)
const chain = viemChain({ rpcUrl: env.RPC_URL, privateKey: env.KEEPER_PRIVATE_KEY as Hex, deployments, engineIdentities })
const marketLogs = new RegistryLogSource(logs, registry.address, BigInt(registry.deployBlock))
const disputeLogs = new TreasuryDisputeSource(logs, treasury.address, BigInt(treasury.deployBlock))
const indexer = env.INDEXER_URL ? new IndexerClient(env.INDEXER_URL, deployments.chainId) : null
const head = () => logs.getBlockNumber()
const source: MarketSource = indexer ? indexedMarkets(indexer, marketLogs, head, env.INDEXER_MAX_LAG_BLOCKS, log) : marketLogs
const disputes: DisputeSource = indexer ? indexedDisputes(indexer, disputeLogs, head, env.INDEXER_MAX_LAG_BLOCKS, log) : disputeLogs

const jobs = planners()
const keeper = new Keeper({ chain, source, planners: jobs, globalPlanners: globalPlanners(disputes), gas, delayMs: env.DELAY_MS, log })
const stop = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop.abort())
log.info('keeper started', { network: env.NETWORK, planners: jobs.length, engineProfiles: engineIdentities.profiles.length, source: env.INDEXER_URL ? 'indexer' : 'registry logs' })
await keeper.run(env.POLL_MS, stop.signal)
