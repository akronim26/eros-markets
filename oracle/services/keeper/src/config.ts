import { loadServiceDeployment, loadGas, type Deployments } from '@eros-oracle/oracle-sdk'
import { readFileSync } from 'node:fs'
import { getAddress, type Hex } from 'viem'
import { z } from 'zod'
import { loadEngineIdentities } from './engineIdentity'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value))
const deployedContract = z.object({
  address,
  codehash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex),
  deployBlock: z.number().int().nonnegative(),
  testnetOnly: z.boolean().optional(),
})
const localContracts = ['Timelock', 'ResolutionOracle', 'MarketRegistry', 'BondTreasury', 'KeeperRouter', 'MockAssertionVenue']
const localDeploymentSchema = z.object({
  scope: z.literal('local-only'),
  network: z.literal('local-integration'),
  chainId: z.literal(31337),
  usdc: address,
  contracts: z.record(z.string(), deployedContract).refine(
    contracts => localContracts.every(name => name in contracts),
    { message: `local contracts must include ${localContracts.join(', ')}` },
  ),
  assertionVenue: z.object({ kind: z.literal('mock'), address }).strict(),
}).refine(
  deployment => deployment.assertionVenue.address === deployment.contracts.MockAssertionVenue?.address,
  { message: 'local assertion venue must match MockAssertionVenue' },
)

export type KeeperDeployments = Pick<Deployments, 'network' | 'chainId' | 'usdc' | 'contracts'>

export function parseLocalKeeperDeployment(value: unknown): KeeperDeployments {
  return localDeploymentSchema.parse(value)
}

export function assertLocalKeeperRpc(value: string): void {
  const endpoint = new URL(value)
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('local-integration RPC must be credential-free HTTP loopback; use an SSH tunnel for remote team access')
  }
}

export const keeperEnvironmentSchema = z.object({
  NETWORK: z.string().default('monad-testnet'),
  RPC_URL: z.url(),
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  ENGINE_IDENTITIES_FILE: z.string().min(1),
  DEPLOYMENTS_FILE: z.string().min(1).optional(),
  DEPLOYMENT_MANIFEST: z.string().min(1).optional(),
  GAS_FILE: z.string().min(1).optional(),
  INDEXER_URL: z.url().optional(),
  INDEXER_MAX_LAG_BLOCKS: z.coerce.bigint().default(300n),
  POLL_MS: z.coerce.number().int().positive().default(15_000),
  DELAY_MS: z.coerce.number().int().nonnegative().default(0),
})

export function loadKeeperConfiguration(values: Record<string, string | undefined>) {
  const env = keeperEnvironmentSchema.parse(values)
  let deployments: KeeperDeployments
  if (env.NETWORK === 'local-integration') {
    if (!env.DEPLOYMENTS_FILE || !env.GAS_FILE) throw new Error('local-integration requires explicit DEPLOYMENTS_FILE and GAS_FILE')
    assertLocalKeeperRpc(env.RPC_URL)
    deployments = parseLocalKeeperDeployment(JSON.parse(readFileSync(env.DEPLOYMENTS_FILE, 'utf8')))
  } else {
    deployments = loadServiceDeployment(env.NETWORK, { deploymentsFile: env.DEPLOYMENTS_FILE, manifestFile: env.DEPLOYMENT_MANIFEST })
  }
  const registry = deployments.contracts.MarketRegistry.address
  const engineIdentities = loadEngineIdentities(env.ENGINE_IDENTITIES_FILE, { chainId: deployments.chainId, registry })
  const gas = loadGas(env.GAS_FILE)
  return { env, deployments, engineIdentities, gas }
}

export async function assertKeeperChain(client: { getChainId(): Promise<number> }, expected: number): Promise<void> {
  const actual = await client.getChainId()
  if (actual !== expected) throw new Error(`keeper RPC chainId ${actual}, expected ${expected}`)
}
