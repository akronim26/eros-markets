import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, http, type Abi } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { viemTransport } from '../../market-ops/src/chain'
import { Operations } from '../../market-ops/src/operations'
import { binding, manifestSchema as operationsManifestSchema } from '../../market-ops/src/schema'
import { FileStore } from '../../market-ops/src/store'
import { assertLocalRpc, json, manifestSchema } from './read-model'
import { localSamplerGas } from './sampler'

// Disposable Anvil operator. Public operators supply their own measured limits to market-ops.
export async function runLocalLiquidator(manifestPath: string, journalPath: string, reportPath: string, once = false) {
  const paths = [manifestPath, journalPath, reportPath].map(value => resolve(value))
  if (new Set(paths).size !== paths.length) throw new Error('LOCAL_LIQUIDATOR_PATHS_MUST_DIFFER')
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(paths[0], 'utf8')))
  assertLocalRpc(manifest.rpcUrl)
  if (manifest.riskScenario !== 'leveraged-fixture') throw new Error('LOCAL_LEVERAGED_FIXTURE_REQUIRED')
  const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }) })
  if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_ONLY')
  if (!(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('LOCAL_ANVIL_ONLY')
  const market = manifest.markets.find(value => value.name === 'demo')!
  const oracle = manifest.contracts.ResolutionOracle
  if (!oracle) throw new Error('LOCAL_ORACLE_MISSING')
  const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 15 })
  const secret = account.getHdKey().privateKey
  if (!secret) throw new Error('LOCAL_ACCOUNT_DERIVATION_FAILED')
  const configuration = operationsManifestSchema.parse({
    chainId: 31337, engine: market.engine, engineCodeHash: market.codehash, listingHash: market.listingHash,
    marketId: market.marketId, oracle: oracle.address, oracleCodeHash: oracle.codehash,
    sender: account.address, sampleEveryBlocks: '1', gas: {},
  })
  const transport = viemTransport(configuration, manifest.rpcUrl, `0x${Buffer.from(secret).toString('hex')}`)
  await transport.snapshot()
  const store = new FileStore(paths[1], binding(configuration))
  const operations = new Operations(configuration, transport, store)
  const abi = JSON.parse(readFileSync(new URL('../../../out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json', import.meta.url), 'utf8')).abi as Abi
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  mkdirSync(dirname(paths[2]), { recursive: true })
  try {
    await (client.request as (input: { method: string; params: unknown[] }) => Promise<unknown>)({
      method: 'anvil_setBalance', params: [account.address, '0x3635c9adc5dea00000'],
    })
    do {
      const snapshot = await transport.snapshot()
      const state = snapshot.liquidation!
      const measurements: { trader: number; estimate: bigint }[] = []
      if (!store.read().pending && !snapshot.halted && state.accountingState === 0 && state.capLots > 0n) {
        let trader = Math.min(store.read().liquidationCursor ?? 1, state.participants)
        for (let examined = 0; examined < Math.min(32, state.participants); ++examined) {
          const estimate = await client.estimateContractGas({ address: market.engine, abi, functionName: 'liquidate',
            args: [trader, state.capLots, 8, 0], account: account.address, blockNumber: snapshot.block })
          measurements.push({ trader, estimate })
          trader = trader === state.participants ? 1 : trader + 1
        }
        if (measurements.length) configuration.gas.liquidate = localSamplerGas(measurements.reduce((max, item) => item.estimate > max ? item.estimate : max, 0n))
      }
      const result = await operations.tick({ action: 'liquidate' }, true)
      writeFileSync(paths[2], json({ scope: 'local-only', engine: market.engine, engineCodeHash: market.codehash,
        sender: account.address, snapshot, result, measurements, gasLimit: configuration.gas.liquidate,
        journal: { cursor: store.read().liquidationCursor, pendingHash: store.read().pending?.hash },
        limitations: 'Controlled fixture; local gas estimates only. Healthy or unpriced accounts produce no transaction.' }) + '\n')
      console.log(json({ result, report: paths[2] }))
      if (once || result.outcome === 'halted') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2000))
    } while (!stopped)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    store.close()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const once = args.includes('--once')
  const paths = args.filter(value => value !== '--once')
  if (paths.length !== 3 || paths.some(value => value.startsWith('--'))) throw new Error('Usage: liquidator.ts manifest.json journal.json report.json [--once]')
  await runLocalLiquidator(paths[0], paths[1], paths[2], once)
}
