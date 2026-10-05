import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http, keccak256, type Abi, type Address, type Hex } from 'viem'
import { assertLocalRpc, json, manifestSchema } from './read-model'
import { assertEnrollmentBindings, parseEnrollmentJson, type EnrollmentMarket } from './enrollment'

const [rawPath, rpcUrl, output, sourceCommit] = process.argv.slice(2)
if (!rawPath || !rpcUrl || !output || !sourceCommit) throw new Error('Usage: enroll.ts raw-manifest rpc-url output source-commit')
assertLocalRpc(rpcUrl)
const raw = parseEnrollmentJson(readFileSync(resolve(rawPath), 'utf8')) as {
  scope: string; chainId: number; startBlock: number; accounts: Record<string, Address>
  contracts: Record<string, { address: Address; codehash: Hex; deployBlock: number }>
  markets: Record<string, EnrollmentMarket>
}
if (raw.scope !== 'local-only' || raw.chainId !== 31337) throw new Error('LOCAL_MANIFEST_ONLY')
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }) })
if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_ONLY')
const block = await client.getBlock({ blockTag: 'latest' })
const contracts = raw.contracts
for (const contract of Object.values(contracts)) {
  const code = await client.getCode({ address: contract.address, blockNumber: block.number })
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== contract.codehash.toLowerCase()) throw new Error('CONTRACT_DEPLOYMENT_MISMATCH')
}
contracts.CollateralToken = contracts.MockUSDC
const artifact = (name: string): Abi => JSON.parse(readFileSync(new URL(`../../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi
const engineAbi = artifact('RegistryBookRiskEngine')
const registryAbi = artifact('MarketRegistry')
const markets = await Promise.all(Object.entries(raw.markets).map(async ([name, market]) => {
  const code = await client.getCode({ address: market.engine, blockNumber: block.number })
  if (!code || code === '0x') throw new Error('ENGINE_NOT_DEPLOYED')
  const codehash = keccak256(code)
  if (market.codehash && codehash.toLowerCase() !== market.codehash.toLowerCase()) throw new Error('ENGINE_DEPLOYMENT_MISMATCH')
  const [actualHash, actual, core, collateralVault, reserveVault] = await Promise.all([
    client.readContract({ address: market.engine, abi: engineAbi, functionName: 'listingHash', blockNumber: block.number }),
    client.readContract({ address: market.engine, abi: engineAbi, functionName: 'listing', blockNumber: block.number }),
    client.readContract({ address: contracts.MarketRegistry.address, abi: registryAbi, functionName: 'getMarketCore', args: [market.marketId], blockNumber: block.number }),
    client.readContract({ address: market.engine, abi: engineAbi, functionName: 'collateralVault', blockNumber: block.number }),
    client.readContract({ address: market.engine, abi: engineAbi, functionName: 'reserveVault', blockNumber: block.number }),
  ])
  assertEnrollmentBindings(market, {
    registry: contracts.MarketRegistry.address, resolutionAuthority: contracts.ResolutionOracle.address,
    collateralVault: contracts.CollateralVault.address, token: contracts.MockUSDC.address,
    monitor: raw.accounts.deployer, governance: contracts.Timelock.address,
  }, { listing: actual, registryEngine: (core as { engine: string }).engine, collateralVault, reserveVault })
  return { name, ...market, listingHash: actualHash as Hex, codehash, deployBlock: Number(raw.startBlock) }
}))
if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('ENROLLMENT_REORGED')
const manifest = manifestSchema.parse({ ...raw, rpcUrl, sourceCommit, contracts, markets, manifestVersion: 1,
  verifiedAt: { blockNumber: block.number.toString(), blockHash: block.hash } })
writeFileSync(resolve(output), json(manifest) + '\n')
console.log(json({ enrolled: manifest.markets.map(market => market.name), block: block.number, scope: 'local-only' }))
