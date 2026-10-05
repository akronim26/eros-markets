import { BondTreasuryAbi, KeeperRouterAbi, MarketRegistryAbi, ResolutionOracleAbi, type GasTable } from '@eros-oracle/oracle-sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, http, keccak256, type Abi, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { z } from 'zod'
import { viemChain } from './chain'
import { assertKeeperChain, assertLocalKeeperRpc, parseLocalKeeperDeployment } from './config'
import { engineFollowUpAbi } from './engineAbi'
import { parseEngineIdentities, type EngineIdentity } from './engineIdentity'
import { planners } from './jobs'
import { Keeper } from './keeper'
import type { Job, Planner, Target } from './types'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value as Hex)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex)
const localMarketsSchema = z.object({ markets: z.object({
  demo: z.object({ engine: address, marketId: hash }),
  terminal: z.object({ engine: address, marketId: hash }),
}) })
const localMnemonic = 'test test test test test test test test test test test junk'
const abis: Record<Target, Abi> = { ResolutionOracle: ResolutionOracleAbi, BondTreasury: BondTreasuryAbi, KeeperRouter: KeeperRouterAbi, Engine: engineFollowUpAbi }
const stringify = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)

export function localGasEntry(estimate: bigint, identity: EngineIdentity, source: string) {
  if (identity.chainId !== 31337 || identity.kind !== 'book-risk' || estimate <= 0n || estimate > 30_000_000n || !source.trim()) {
    throw new Error('local gas measurement requires a positive bounded estimate and local real-engine identity')
  }
  const padded = (estimate * 125n + 99n) / 100n + 10_000n
  const limit = padded > 30_000_000n ? 30_000_000n : padded
  return {
    limit: Number(limit),
    engine: 'RegistryBookRiskEngine',
    engineRuntimeCodehashes: [identity.runtimeCodehash],
    measurement: { chainId: 31337, source, transactionGas: Number(estimate), kind: 'local-rpc-estimate' },
  }
}

export async function runLocalKeeper(manifestPath: string, gasPath: string, reportPath: string, rpcUrl: string) {
  assertLocalKeeperRpc(rpcUrl)
  const input = resolve(manifestPath)
  const gasOutput = resolve(gasPath)
  const reportOutput = resolve(reportPath)
  if (new Set([input, gasOutput, reportOutput]).size !== 3) throw new Error('manifest, gas and report paths must differ')
  const raw = JSON.parse(readFileSync(input, 'utf8'))
  const deployments = parseLocalKeeperDeployment(raw)
  const { markets } = localMarketsSchema.parse(raw)
  const transport = http(rpcUrl, { timeout: 10000, retryCount: 0, fetchOptions: { redirect: 'error' } })
  const client = createPublicClient({ transport })
  await assertKeeperChain(client, 31337)
  const version = await client.request({ method: 'web3_clientVersion' })
  if (!version.toLowerCase().includes('anvil')) throw new Error('local keeper driver requires a disposable Anvil node')
  for (const contract of Object.values(deployments.contracts)) {
    const code = await client.getCode({ address: contract.address })
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== contract.codehash.toLowerCase()) throw new Error('local contract identity changed')
  }
  const runtimeProfiles = await Promise.all(Object.values(markets).map(async market => {
    const core = await client.readContract({ address: deployments.contracts.MarketRegistry.address, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [market.marketId] })
    if (core.engine.toLowerCase() !== market.engine.toLowerCase()) throw new Error('local market does not match the registry')
    const code = await client.getCode({ address: market.engine })
    if (!code || code === '0x') throw new Error('local market has no engine code')
    return { kind: 'book-risk', runtimeCodehash: keccak256(code) }
  }))
  const context = { chainId: 31337, registry: deployments.contracts.MarketRegistry.address }
  const engineIdentities = parseEngineIdentities({ version: 1, ...context, profiles: runtimeProfiles }, context)
  const account = mnemonicToAccount(localMnemonic, { addressIndex: 10 })
  const privateKey = account.getHdKey().privateKey
  if (!privateKey) throw new Error('local fixture account derivation failed')
  await (client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: 'anvil_setBalance', params: [account.address, '0x3635c9adc5dea00000'] })
  const chain = viemChain({ rpcUrl, privateKey: `0x${Buffer.from(privateKey).toString('hex')}`, deployments, engineIdentities })
  const gas: GasTable = { calls: {} }
  const measurements: Record<string, unknown>[] = []
  const logs: Record<string, unknown>[] = []
  const receipts: Record<string, unknown>[] = []
  const tickReports: Record<string, unknown>[] = []
  const call = (job: Job) => ({ address: job.target === 'Engine' ? job.address! : deployments.contracts[job.target].address, abi: abis[job.target], functionName: job.functionName, args: job.args, account: account.address })
  const measuredPlanners: Planner[] = planners().map(planner => async view => {
    const eligible: Job[] = []
    for (const job of await planner(view)) {
      try {
        const simulated = await chain.simulate(job)
        if ((job.isNoop ?? (result => result === false))(simulated)) continue
        const block = await client.getBlock()
        const estimate = await client.estimateContractGas({ ...call(job), blockNumber: block.number })
        const entry = localGasEntry(estimate, view.engineIdentity, `${reportOutput}#estimate:${measurements.length}`)
        const previous = gas.calls[job.gasKey]
        gas.calls[job.gasKey] = { ...entry, limit: Math.max(previous?.limit ?? 0, entry.limit) }
        measurements.push({ gasKey: job.gasKey, action: job.action, marketId: job.marketId, blockNumber: block.number, blockHash: block.hash, estimate, engineRuntimeCodehash: view.engineIdentity.runtimeCodehash })
        eligible.push(job)
      } catch {
        logs.push({ phase: 'local-measurement', action: job.action, outcome: 'simulation-or-estimate-refused' })
      }
    }
    return eligible
  })
  const keeper = new Keeper({ chain, source: { marketIds: async () => Object.values(markets).map(market => market.marketId) }, planners: measuredPlanners, gas, concurrency: 1,
    log: { info: (message, data) => logs.push({ level: 'info', message, ...data }), warn: (message, data) => logs.push({ level: 'warn', message, ...data }), error: (message, data) => logs.push({ level: 'error', message, ...data }) },
  })
  const write = () => {
    for (const output of [gasOutput, reportOutput]) mkdirSync(dirname(output), { recursive: true })
    writeFileSync(gasOutput, `${stringify({ scope: 'local-only', evidence: 'current fixture states only; not production worst-case gas', ...gas })}\n`)
    writeFileSync(reportOutput, `${stringify({ scope: 'local-only', chainId: 31337, mockAssertionVenue: true, keeper: account.address, engineIdentities, measurements, receipts, tickReports, logs })}\n`)
  }
  try {
    for (let tick = 0; tick < 32; tick++) {
      const demo = await chain.settlementStatus(markets.demo.engine)
      if (demo.halted) throw new Error('ongoing demo market must remain unhalted')
      const status = await chain.settlementStatus(markets.terminal.engine)
      if (status.claimsEnabled) {
        write()
        return { claimsEnabled: true, ticks: tickReports.length, transactions: receipts.length, keeper: account.address }
      }
      const report = await keeper.tick()
      tickReports.push({ tick, markets: report.markets, unreadable: report.unreadable, results: report.results.map(result => ({ action: result.job.action, marketId: result.job.marketId, outcome: result.outcome, hash: result.hash })) })
      const sent = report.results.filter(result => result.outcome === 'sent' && result.hash)
      if (!sent.length) throw new Error('local keeper made no progress; inspect the report rather than bypassing checks')
      for (const result of sent) {
        const receipt = await client.waitForTransactionReceipt({ hash: result.hash!, timeout: 30000, pollingInterval: 100 })
        receipts.push({ hash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, status: receipt.status, action: result.job.action, gasKey: result.job.gasKey })
        if (receipt.status !== 'success') throw new Error('local keeper transaction reverted')
        const entry = gas.calls[result.job.gasKey]
        entry.measurement = { chainId: 31337, source: `local receipt ${receipt.transactionHash}`, transactionGas: Number(receipt.gasUsed), kind: 'local-receipt' }
      }
      write()
    }
    throw new Error('local keeper exceeded its bounded tick limit')
  } finally {
    write()
  }
}

if (import.meta.main) {
  const [manifestPath, gasPath, reportPath, extra] = process.argv.slice(2)
  if (!manifestPath || !gasPath || !reportPath || extra) throw new Error('Usage: bun src/local-integration.ts <manifest.json> <local-gas.json> <keeper-report.json>')
  const result = await runLocalKeeper(manifestPath, gasPath, reportPath, process.env.RPC_URL ?? 'http://127.0.0.1:18545')
  console.log(stringify(result))
}
