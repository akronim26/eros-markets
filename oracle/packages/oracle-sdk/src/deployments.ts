// Validated loading of deployments/<network>.json and gas.json, so a bad file fails at startup, not mid-job.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { z } from 'zod'
import { ORACLE_ROOT } from './abi/sources'
import { toPublicManifest } from './trading-manifest'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a))
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as z.ZodType<`0x${string}`>
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).transform((s) => BigInt(s))

const deployed = z.object({
  address,
  codehash: bytes32,
  deployBlock: z.number().int().nonnegative(),
  testnetOnly: z.boolean().optional(),
})

/** Contracts every network has. StubMarketFactory exists on testnets only. */
export const CORE_CONTRACTS = ['Timelock', 'ResolutionOracle', 'MarketRegistry', 'BondTreasury', 'UmaAdapter', 'KeeperRouter'] as const

export const deploymentsSchema = z.object({
  network: z.string().min(1),
  chainId: z.number().int().positive(),
  creChainSelector: decimal,
  usdc: address,
  roles: z.object({ timelock: address, teamSafe: address, guardianSafe: address, lister: address }),
  contracts: z
    .record(z.string(), deployed)
    .refine((c) => CORE_CONTRACTS.every((name) => name in c), { message: `contracts must include ${CORE_CONTRACTS.join(', ')}` }),
  uma: z.object({
    finder: address.optional(),
    store: address.optional(),
    addressWhitelist: address.optional(),
    identifierWhitelist: address.optional(),
    oov3: address,
    sandboxOracle: address.optional(),
    finalFeeAtoms: decimal.optional(),
  }),
  cre: z.object({
    mockForwarder: address,
    keystoneForwarder: address,
    orgOwner: address,
    workflowName: z.string(),
    workflowIds: z.array(bytes32),
    simRelayers: z.array(address),
  }),
  trustSets: z.array(z.object({
    id: z.number().int().positive(),
    production: z.boolean(),
    active: z.boolean(),
    attestor: address,
    committee: z.array(address),
    threshold: z.number().int().positive(),
    watchdog: address,
    venue: address,
  })),
  globalsVersion: z.number().int().nonnegative(),
  timelockOps: z.array(z.object({
    id: bytes32,
    target: address,
    selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
    readyAt: z.number().int().nonnegative(),
    executed: z.boolean(),
  })),
})

export type Deployments = z.infer<typeof deploymentsSchema>
export type ServiceDeployment = Pick<Deployments, 'network' | 'chainId' | 'usdc' | 'contracts'> & { markets?: { marketId: `0x${string}` }[] }
export const CURRENT_TESTNET_MANIFEST = join(ORACLE_ROOT, '..', 'frontend', 'src', 'config', 'public-manifest.json')

/** Service identity defaults to the same verified manifest as the frontend. Historical records require an explicit path. */
export function loadServiceDeployment(network: string, opts: { deploymentsFile?: string; manifestFile?: string } = {}): ServiceDeployment {
  if (opts.deploymentsFile && opts.manifestFile) throw new DeploymentsError('Choose DEPLOYMENTS_FILE or DEPLOYMENT_MANIFEST, not both')
  if (opts.deploymentsFile) return loadDeployments(network, { path: opts.deploymentsFile })
  if (network !== 'monad-testnet') {
    if (opts.manifestFile) throw new DeploymentsError('DEPLOYMENT_MANIFEST is supported only for monad-testnet')
    return loadDeployments(network)
  }
  const manifest = toPublicManifest(JSON.parse(readFileSync(opts.manifestFile ?? CURRENT_TESTNET_MANIFEST, 'utf8')))
  if (manifest.chainId !== 10143 || manifest.scope !== 'testnet-read-only' || !manifest.verifiedAt || manifest.provenance.resolution !== 'oracle') {
    throw new DeploymentsError('Verified Monad testnet oracle manifest required')
  }
  for (const name of [...CORE_CONTRACTS, 'CollateralToken']) {
    const pin = manifest.contracts[name]
    if (!pin || /^0x0{40}$/i.test(pin.address) || /^0x0{64}$/i.test(pin.codehash)
      || BigInt(pin.deployBlock) > BigInt(manifest.verifiedAt.blockNumber)) throw new DeploymentsError(`Invalid current deployment pin: ${name}`)
  }
  return { network, chainId: manifest.chainId, usdc: manifest.contracts.CollateralToken.address, contracts: manifest.contracts, markets: manifest.markets }
}

export const gasSchema = z.object({
  calls: z.record(z.string(), z.object({
    limit: z.number().int().positive(),
    transaction: z.number().int().positive().optional(),
    execution: z.number().int().positive().optional(),
    budget: z.number().int().positive().optional(),
    status: z.string().optional(),
  }).loose()),
}).loose()

export type GasTable = z.infer<typeof gasSchema>

export class DeploymentsError extends Error {}

function parse<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new DeploymentsError(`${what}: not JSON (${(e as Error).message})`)
  }
  const r = schema.safeParse(raw)
  if (!r.success) throw new DeploymentsError(`${what}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return r.data
}

export const deploymentsPath = (network: string, dir = join(ORACLE_ROOT, 'deployments')) => join(dir, `${network}.json`)

/** deployments/<network>.json, validated; `expectChainId` guards against loading another network's file. */
export function loadDeployments(network: string, opts: { dir?: string; path?: string; expectChainId?: number } = {}): Deployments {
  const path = opts.path ?? deploymentsPath(network, opts.dir)
  const d = parse(deploymentsSchema, readFileSync(path, 'utf8'), path)
  if (d.network !== network) throw new DeploymentsError(`${path}: network is ${d.network}, expected ${network}`)
  if (opts.expectChainId !== undefined && d.chainId !== opts.expectChainId) {
    throw new DeploymentsError(`${path}: chainId ${d.chainId}, expected ${opts.expectChainId}`)
  }
  return d
}

/** gas.json: the measured gas limit for each call type. */
export function loadGas(path = join(ORACLE_ROOT, 'deployments', 'gas.json')): GasTable {
  return parse(gasSchema, readFileSync(path, 'utf8'), path)
}

/** Throws for a call type gas.json does not list, rather than guess a limit. */
export function gasLimit(gas: GasTable, call: string): bigint {
  const c = gas.calls[call]
  if (!c) throw new DeploymentsError(`gas.json has no limit for ${call}`)
  return BigInt(c.limit)
}

/** A deployed contract's address; throws for a contract the network does not have. */
export function contractAddress(d: Pick<Deployments, 'network' | 'contracts'>, name: string): `0x${string}` {
  const c = d.contracts[name]
  if (!c) throw new DeploymentsError(`${d.network} has no ${name}`)
  return c.address as `0x${string}`
}
