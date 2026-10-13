import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, decodeEventLog, http, type Abi, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { viemTransport } from '../../market-ops/src/chain'
import { Operations } from '../../market-ops/src/operations'
import { binding, manifestSchema as operationsManifestSchema } from '../../market-ops/src/schema'
import { FileStore } from '../../market-ops/src/store'
import { assertLocalRpc, json, manifestSchema } from './read-model'
import { tryLocalSamplingLock } from '../../../../packages/pricefeed/scripts/local-sampling-lock'

export function localSamplerGas(estimate: bigint, paddingPercent = 130): number {
  if (estimate <= 0n || estimate > 30_000_000n) throw new Error('LOCAL_SAMPLER_GAS_OUT_OF_BOUNDS')
  if (!Number.isSafeInteger(paddingPercent) || paddingPercent < 100 || paddingPercent > 300) throw new Error('LOCAL_SAMPLER_PADDING_OUT_OF_BOUNDS')
  const padded = (estimate * BigInt(paddingPercent) + 99n) / 100n + 10_000n
  return Number(padded > 30_000_000n ? 30_000_000n : padded)
}

export async function runLocalSampler(manifestPath: string, journalPath: string, reportPath: string, once = false) {
  const paths = [manifestPath, journalPath, reportPath].map(value => resolve(value))
  if (new Set(paths).size !== paths.length) throw new Error('LOCAL_SAMPLER_PATHS_MUST_DIFFER')
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(paths[0], 'utf8')))
  assertLocalRpc(manifest.rpcUrl)
  const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }) })
  if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_ONLY')
  if (!(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('LOCAL_ANVIL_ONLY')
  const market = manifest.markets.find(value => value.name === 'demo')!
  const oracle = manifest.contracts.ResolutionOracle
  if (!oracle) throw new Error('LOCAL_ORACLE_MISSING')
  const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 11 })
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
  const call = { address: market.engine, abi, functionName: 'samplePerp', account: account.address }
  const observed = new Set<Hex>()
  const receipts: unknown[] = []
  const measurements: unknown[] = []
  const counters = { validPerpObservations: 0, invalidPerpObservations: 0, bookDepthCaptures: 0, confirmedTransactions: 0 }
  let latestValidSample: unknown = null
  let stopped = false
  let releaseSampling: (() => void) | undefined
  const stop = () => { stopped = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  mkdirSync(dirname(paths[2]), { recursive: true })
  try {
    await (client.request as (input: { method: string; params: unknown[] }) => Promise<unknown>)({
      method: 'anvil_setBalance', params: [account.address, '0x3635c9adc5dea00000'],
    })
    do {
      if (manifest.riskScenario === 'leveraged-fixture' && !releaseSampling) {
        releaseSampling = tryLocalSamplingLock(resolve(dirname(paths[0]), 'sampling.lock')) ?? undefined
        if (!releaseSampling) { await new Promise(resolveDelay => setTimeout(resolveDelay, 200)); continue }
      }
      const snapshot = await transport.snapshot()
      const epoch = await client.readContract({ address: market.engine, abi, functionName: 'epoch', blockNumber: snapshot.block }) as readonly [bigint, bigint, bigint, ...unknown[]]
      const maintenance = snapshot.liquidation?.accountingState !== 0 || snapshot.timestamp + 4n >= epoch[2]
      if (!store.read().pending && !maintenance && !snapshot.halted && snapshot.timestamp < snapshot.scheduledT) {
        const estimate = await client.estimateContractGas({ ...call, blockNumber: snapshot.block })
        // A newer INDEX can turn an invalid capture into a valid publication between
        // estimate and inclusion, adding checkpoint writes. Local fixtures reserve
        // a larger, explicitly recorded cushion for that transition; no public gas claim.
        configuration.gas.samplePerp = localSamplerGas(estimate, 300)
        measurements.push({ block: snapshot.block, timestamp: snapshot.timestamp, estimate, paddingPercent: 300, limit: configuration.gas.samplePerp })
        if (measurements.length > 100) measurements.shift()
      }
      // Do not publish the temporary empty book while accounts roll. Previously
      // published observations still expire normally after 30 seconds.
      const result = !store.read().pending && maintenance && !snapshot.halted
        ? { outcome: 'no-work' as const, action: 'sample' as const, hash: undefined }
        : await operations.tick({ action: 'sample' }, true)
      if (result.outcome === 'finalized' && result.hash && !observed.has(result.hash)) {
        const receipt = await client.getTransactionReceipt({ hash: result.hash })
        const events: unknown[] = []
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== market.engine.toLowerCase()) continue
          try {
            const event = decodeEventLog({ abi, topics: log.topics, data: log.data })
            if (event.eventName === 'BookDepthCaptured') counters.bookDepthCaptures++
            if (event.eventName === 'PerpObservationRecorded') {
              if ((event.args as unknown as { valid: boolean }).valid) {
                counters.validPerpObservations++
                latestValidSample = { transactionHash: result.hash, blockNumber: receipt.blockNumber,
                  blockHash: receipt.blockHash, observation: event.args }
              } else counters.invalidPerpObservations++
            }
            events.push(event)
          } catch {}
        }
        counters.confirmedTransactions++
        observed.add(result.hash)
        receipts.push({ hash: result.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          status: receipt.status, gasUsed: receipt.gasUsed, events })
        if (receipts.length > 100) receipts.shift()
      }
      const block = await client.getBlock({ blockTag: 'latest' })
      const risk = await client.readContract({ address: market.engine, abi, functionName: 'marketRiskView', blockNumber: block.number })
      const source = await client.readContract({ address: market.engine, abi, functionName: 'sourceState', args: [market.sourceId], blockNumber: block.number })
      if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('LOCAL_SAMPLER_REPORT_REORGED')
      writeFileSync(paths[2], json({ scope: 'local-only', chainId: 31337, engine: market.engine, sender: account.address,
        engineCodeHash: market.codehash, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
        result, counters, latestValidSample, risk, source, receipts, measurements,
        limitations: 'Controlled INDEX; actual sampler and journal. No forced publication, prefix bypass or mainnet gas claim.' }) + '\n')
      console.log(json({ result, counters, report: paths[2] }))
      // Keep publication and its finality reconciliation in the same local critical
      // section. The source driver reads its next observedAt only after release.
      if (!store.read().pending) { releaseSampling?.(); releaseSampling = undefined }
      if (once || result.outcome === 'halted') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, manifest.riskScenario === 'leveraged-fixture' ? 200 : 2000))
    } while (!stopped)
  } finally {
    releaseSampling?.()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    store.close()
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const once = args.includes('--once')
  const paths = args.filter(value => value !== '--once')
  if (paths.length < 2 || paths.length > 3 || paths.some(value => value.startsWith('--'))) {
    throw new Error('Usage: sampler.ts manifest.json journal.json [report.json] [--once]')
  }
  await runLocalSampler(paths[0], paths[1], paths[2] ?? `${paths[1]}.report.json`, once)
}
