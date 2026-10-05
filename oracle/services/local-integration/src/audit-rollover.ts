/** Read-only verification shared by the controlled and real-source local proofs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, decodeEventLog, decodeFunctionData, http, keccak256, type Address, type Hex } from 'viem'
import { RolloverBatcherAbi, rolloverBatchGas } from '../../market-ops/src/rollover-batch'
import { assertLocalRpc, json, manifestSchema, type Manifest } from './read-model'
import type { AuditClient } from './audit-live'

export const LOCAL_OPERATOR = '0xfabb0ac9d68b0b445fb7357272ff202c5651694a' as Address
export type BatchMetadata = { pages: number; estimatedGas: string; gasLimit: string; estimateBlock: string; estimationMs: number;
  searchStop?: { pages: number; reason: 'opaque-empty-revert' } }
const same = (left: string | null | undefined, right: string) => left?.toLowerCase() === right.toLowerCase()

export async function auditRolloverBatch(manifest: Manifest, engine: Address,
  receipt: Awaited<ReturnType<AuditClient['getTransactionReceipt']>>,
  tx: Awaited<ReturnType<AuditClient['getTransaction']>>, metadata: BatchMetadata | undefined,
  client: Pick<AuditClient, 'getCode'>) {
  const helper = manifest.contracts.RolloverBatcher
  const market = manifest.markets.find(value => same(value.engine, engine))
  assert.ok(helper && market && same(tx.to, helper.address), 'ROLLOVER_AUDIT_TARGET')
  assert.ok(same(tx.from, LOCAL_OPERATOR), 'ROLLOVER_AUDIT_OPERATOR')
  assert.equal(tx.value, 0n); assert.ok(tx.gas > 0n && tx.gas <= 30_000_000n, 'ROLLOVER_AUDIT_GAS_CAP')
  for (const identity of [helper, { address: engine, codehash: market.codehash }]) {
    const code = await client.getCode({ address: identity.address, blockNumber: receipt.blockNumber })
    assert.ok(code && code !== '0x' && same(keccak256(code), identity.codehash), 'ROLLOVER_AUDIT_CODE_CHANGED')
  }
  const call = decodeFunctionData({ abi: RolloverBatcherAbi, data: tx.input })
  assert.equal(call.functionName, 'rollover')
  const [target, epoch, work, cursor, maxPages] = call.args
  assert.ok(same(target, engine) && epoch > 0n && work <= 1 && cursor <= 1024n && maxPages >= 1 && maxPages <= 32, 'ROLLOVER_AUDIT_CALLDATA')
  assert.ok(metadata && metadata.pages === maxPages && Number.isSafeInteger(metadata.estimationMs) && metadata.estimationMs >= 0,
    'ROLLOVER_AUDIT_PLAN_METADATA')
  if (metadata.searchStop) assert.ok(metadata.searchStop.reason === 'opaque-empty-revert' && Number.isInteger(metadata.searchStop.pages)
    && metadata.searchStop.pages > maxPages && metadata.searchStop.pages <= 32, 'ROLLOVER_AUDIT_SEARCH_STOP')
  assert.ok(BigInt(metadata.estimateBlock) >= 0n && BigInt(metadata.estimateBlock) <= receipt.blockNumber, 'ROLLOVER_AUDIT_ESTIMATE_BLOCK')
  assert.equal(BigInt(metadata.gasLimit), tx.gas, 'ROLLOVER_AUDIT_GAS_LIMIT')
  assert.equal(rolloverBatchGas(BigInt(metadata.estimatedGas)), tx.gas, 'ROLLOVER_AUDIT_GAS_MARGIN')
  const events = receipt.logs.flatMap(log => {
    if (!same(log.address, helper.address)) return []
    try {
      const event = decodeEventLog({ abi: RolloverBatcherAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      return event.eventName === 'RolloverAdvanced' ? [event.args] : []
    } catch { return [] }
  })
  assert.equal(events.length, 1, 'ROLLOVER_AUDIT_PROGRESS_EVENT')
  const event = events[0], start = work === 0 ? 0n : cursor
  assert.ok(same(event.engine, engine) && event.epoch === epoch && event.count <= 1024n && start <= event.count,
    'ROLLOVER_AUDIT_EVENT_BINDING')
  const wanted = start + 32n * BigInt(maxPages), end = wanted < event.count ? wanted : event.count
  assert.equal(event.cursor, end, 'ROLLOVER_AUDIT_PROGRESS')
  assert.equal(event.pages, Number((end - start + 31n) / 32n), 'ROLLOVER_AUDIT_PAGES')
  assert.equal(event.completed, end === event.count, 'ROLLOVER_AUDIT_COMPLETION')
  return { ...metadata, expectedEpoch: epoch, expectedWork: work, expectedCursor: cursor, progress: event }
}

if (import.meta.main) {
  const [manifestPath, reportPath, output] = process.argv.slice(2)
  if (!manifestPath || !reportPath || !output) throw new Error('Usage: audit-rollover.ts manifest upkeep-report output')
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  assertLocalRpc(manifest.rpcUrl); assert.equal(manifest.scope, 'local-only'); assert.equal(manifest.chainId, 31337)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(report.scope, 'local-only'); assert.equal(report.chainId, 31337); assert.ok(same(report.operator, LOCAL_OPERATOR))
  const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }), cacheTime: 0 })
  assert.equal(await client.getChainId(), 31337, 'ROLLOVER_AUDIT_CHAIN')
  const finalized = await client.getBlock({ blockTag: 'finalized' }), batches = [], seen = new Set<string>()
  for (const entry of report.receipts) {
    if (entry.action !== 'rollover') { assert.ok(!entry.rolloverBatch, 'ROLLOVER_AUDIT_UNEXPECTED_METADATA'); continue }
    assert.ok(!seen.has(entry.hash.toLowerCase()), 'ROLLOVER_AUDIT_DUPLICATE'); seen.add(entry.hash.toLowerCase())
    const receipt = await client.getTransactionReceipt({ hash: entry.hash }), tx = await client.getTransaction({ hash: entry.hash })
    assert.ok(same(receipt.transactionHash, entry.hash) && same(tx.hash, entry.hash), 'ROLLOVER_AUDIT_HASH')
    assert.equal(receipt.status, 'success'); assert.equal(receipt.blockNumber, BigInt(entry.blockNumber))
    assert.ok(same(receipt.blockHash, entry.blockHash) && receipt.blockNumber <= finalized.number, 'ROLLOVER_AUDIT_RECEIPT')
    assert.equal(receipt.gasUsed, BigInt(entry.gasUsed)); assert.ok(receipt.gasUsed <= tx.gas, 'ROLLOVER_AUDIT_GAS_USED'); assert.equal(entry.actor, 'operator')
    const block = await client.getBlock({ blockNumber: receipt.blockNumber })
    assert.ok(same(block.hash, receipt.blockHash), 'ROLLOVER_AUDIT_REORG')
    const market = manifest.markets.find(value => value.name === entry.market)
    assert.ok(market && entry.rolloverBatch, 'ROLLOVER_AUDIT_MARKET')
    const metadata = { pages: entry.rolloverBatch.pages, estimatedGas: entry.estimate, gasLimit: String(entry.gasLimit),
      estimateBlock: entry.plannedBlock, estimationMs: entry.rolloverBatch.estimationMs,
      ...(entry.rolloverBatch.searchStop ? { searchStop: entry.rolloverBatch.searchStop } : {}) }
    const verified = await auditRolloverBatch(manifest, market.engine, receipt, tx, metadata, client)
    assert.equal(verified.expectedEpoch, BigInt(entry.rolloverBatch.epoch))
    assert.equal(verified.expectedWork, entry.rolloverBatch.work)
    assert.equal(verified.expectedCursor, BigInt(entry.rolloverBatch.cursor))
    batches.push({ hash: entry.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, ...verified })
  }
  assert.ok(batches.length > 0, 'ROLLOVER_AUDIT_NO_BATCHES')
  for (const batch of batches) assert.ok(same((await client.getBlock({ blockNumber: batch.blockNumber })).hash, batch.blockHash), 'ROLLOVER_AUDIT_REORG')
  const inputSha256 = Object.fromEntries(Object.entries({ manifest: manifestPath, upkeep: reportPath })
    .map(([name, path]) => [name, createHash('sha256').update(readFileSync(path)).digest('hex')]))
  const result = { mode: 'LOCAL_ROLLOVER_BATCH_AUDIT', passed: true, chainId: 31337, publicTransactions: 0, inputSha256, batches }
  writeFileSync(output, json(result) + '\n', { flag: 'wx' })
  console.log(json({ passed: true, batches: batches.length, publicTransactions: 0 }))
}
