/** Read-only, chain-bound reconciliation of the live-source actor proof. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, decodeEventLog, decodeFunctionData, erc20Abi, http, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem'
import { RegistryBookRiskEngineAbi as engineAbi, CollateralVaultAbi as vaultAbi, MarketRegistryAbi as registryAbi } from '../../../packages/oracle-sdk/src/browser'
import { assertLocalRpc, json, manifestSchema, type Manifest } from './read-model'
import { RolloverBatcherAbi } from '../../market-ops/src/rollover-batch'
import { auditRolloverBatch, type BatchMetadata } from './audit-rollover'

export const LIVE_OWNERS = ['0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec', '0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097'] as const
const SAMPLER = '0x71bE63f3384f5fb98995898A86B02Fb2426c5788'
const ACTORS = new Set(['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0xfabb0ac9d68b0b445fb7357272ff202c5651694a',
  '0x2546bcd3c84621e976d8185a91a922ae77ecec30', '0xbda5747bfd65f08deb54cb465eb87d40e51b197e', ...LIVE_OWNERS.map(owner => owner.toLowerCase())])
const Q = 10n ** 18n, LOTS = 100_000n
const same = (left: string | null | undefined, right: string) => left?.toLowerCase() === right.toLowerCase()
type NumberValue = string | number | bigint
type HashRecord = { hash?: Hex; transactionHash?: Hex }
type ReceiptRecord = HashRecord & { blockNumber: NumberValue; blockHash: Hex; gasUsed: NumberValue; gasLimit?: NumberValue; actor: Address; action: string; rolloverBatch?: BatchMetadata }
type RiskRecord = { trader?: NumberValue; cashQ: NumberValue; positionLots: NumberValue; e0Q: NumberValue; e1Q: NumberValue }
type BlockRecord = { number: NumberValue; hash: Hex; timestamp?: NumberValue }
type SampleRecord = { transactionHash: Hex; blockNumber: NumberValue; blockHash: Hex;
  observation: { t: NumberValue; midWad: NumberValue; valid: boolean; basisWad: NumberValue; basisValid: boolean } }
export type ActorsReport = { complete: boolean; engine: Address; listingHash: Hex; receipts: ReceiptRecord[];
  trade: { tick: number; lots: NumberValue; collateralAtoms: NumberValue[]; accounts: RiskRecord[]; slacks: NumberValue[]; blockNumber: NumberValue; blockHash: Hex };
  postTradeSample: SampleRecord }
export type SnapshotReport = { block: BlockRecord; recognizedAtoms: NumberValue; custodyAtoms: NumberValue;
  markets: Array<{ name: string; engine: Address; accounts: Array<{ name: string; owner: Address; risk: RiskRecord | null }>;
    reserveCoverage: { slacks: NumberValue[]; recoveryEnabled: boolean } }> }
export type PricefeedAudit = { passed: boolean; chainId: number; canonicalReceiptsVerified: boolean;
  config: { destination: { engineAddress: Address } }; publisherReceipts: HashRecord[]; samplerReceipts: HashRecord[] }
type ChainBlock = { number: bigint; hash: Hex; timestamp: bigint }
type ChainLog = { address: Address; data: Hex; topics: readonly Hex[] }
type ChainReceipt = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: string; gasUsed: bigint; logs: readonly ChainLog[] }
type ChainTransaction = { hash: Hex; from: Address; to: Address | null; input: Hex; gas: bigint; value: bigint }
export type AuditClient = {
  getChainId(): Promise<number>
  getBlock(args: { blockTag: 'finalized' } | { blockNumber: bigint }): Promise<ChainBlock>
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber: bigint }): Promise<unknown>
  getTransactionReceipt(args: { hash: Hex }): Promise<ChainReceipt>
  getTransaction(args: { hash: Hex }): Promise<ChainTransaction>
}

export function assertUniqueReceiptSets(sets: Record<string, readonly HashRecord[]>) {
  const seen = new Map<string, string>()
  for (const [role, receipts] of Object.entries(sets)) {
    for (const receipt of receipts) {
      const hash = receipt.transactionHash ?? receipt.hash
      assert.ok(hash && /^0x[0-9a-fA-F]{64}$/.test(hash), 'LIVE_AUDIT_INVALID_HASH')
      assert.ok(!seen.has(hash.toLowerCase()), `LIVE_AUDIT_DUPLICATE_RECEIPT:${role}:${seen.get(hash.toLowerCase())}`)
      seen.set(hash.toLowerCase(), role)
    }
  }
  return seen.size
}

function compareRisk(actual: RiskRecord, reported: RiskRecord) {
  for (const field of ['cashQ', 'positionLots', 'e0Q', 'e1Q'] as const) {
    assert.equal(BigInt(reported[field]), BigInt(actual[field]), `LIVE_AUDIT_REPORTED_${field}_MISMATCH`)
  }
}

export async function auditLiveState(manifest: Manifest, actors: ActorsReport, snapshot: SnapshotReport, pricefeed: PricefeedAudit, client: AuditClient) {
  assertLocalRpc(manifest.rpcUrl)
  assert.equal(manifest.scope, 'local-only'); assert.equal(manifest.chainId, 31337)
  assert.equal(await client.getChainId(), 31337, 'LIVE_AUDIT_WRONG_CHAIN')
  assert.equal(actors.complete, true, 'LIVE_AUDIT_INCOMPLETE')
  assert.equal(pricefeed.passed, true); assert.equal(pricefeed.canonicalReceiptsVerified, true); assert.equal(pricefeed.chainId, 31337)
  const market = manifest.markets.find(value => value.name === 'demo')!
  assert.ok(market && same(actors.engine, market.engine) && same(actors.listingHash, market.listingHash), 'LIVE_AUDIT_ENGINE_BINDING')
  assert.ok(same(pricefeed.config.destination.engineAddress, market.engine), 'LIVE_AUDIT_PRICEFEED_BINDING')
  assert.equal(BigInt(actors.trade.lots), LOTS); assert.equal(actors.trade.accounts.length, 2)
  assert.equal(actors.trade.collateralAtoms.length, 2); assert.equal(actors.trade.slacks.length, 2)
  assert.ok(Number.isInteger(actors.trade.tick) && actors.trade.tick >= 1 && actors.trade.tick <= 999, 'LIVE_AUDIT_TICK')
  const uniqueReceipts = assertUniqueReceiptSets({ actors: actors.receipts, publisher: pricefeed.publisherReceipts, sampler: pricefeed.samplerReceipts })
  const final = await client.getBlock({ blockTag: 'finalized' })
  const vault = manifest.contracts.CollateralVault.address, token = manifest.contracts.CollateralToken.address
  const read = (functionName: string, args: readonly unknown[], blockNumber: bigint, address = market.engine, abi: Abi = engineAbi) =>
    client.readContract({ address, abi, functionName, args, blockNumber })
  const blocks = new Map<bigint, ChainBlock>()
  const canonical = async (number: bigint, hash: Hex) => {
    assert.ok(number <= final.number, 'LIVE_AUDIT_UNFINALIZED_BLOCK')
    const block = blocks.get(number) ?? await client.getBlock({ blockNumber: number })
    blocks.set(number, block)
    assert.equal(block.hash.toLowerCase(), hash.toLowerCase(), 'LIVE_AUDIT_REORGED')
    return block
  }
  async function stateAt(number: bigint, hash: Hex) {
    const block = await canonical(number, hash)
    const identities = [...Object.values(manifest.contracts), { address: market.engine, codehash: market.codehash }]
    for (const identity of identities) {
      const code = await client.getCode({ address: identity.address, blockNumber: number })
      assert.ok(code && code !== '0x' && same(keccak256(code), identity.codehash), 'LIVE_AUDIT_CODE_CHANGED')
    }
    assert.ok(same(await read('listingHash', [], number) as Hex, market.listingHash), 'LIVE_AUDIT_LISTING_CHANGED')
    assert.ok(same(await read('collateralVault', [], number) as Address, vault), 'LIVE_AUDIT_VAULT_CHANGED')
    const core = await read('getMarketCore', [market.marketId], number, manifest.contracts.MarketRegistry.address, registryAbi) as { engine: Address }
    assert.ok(same(core.engine, market.engine), 'LIVE_AUDIT_REGISTRY_CHANGED')
    const accounts = []
    for (const [side, owner] of LIVE_OWNERS.entries()) {
      const trader = await read('participantId', [owner], number) as number
      assert.ok(trader > 0, 'LIVE_AUDIT_OWNER_UNREGISTERED')
      const risk = await read('accountRiskView', [trader], number) as RiskRecord
      assert.equal(BigInt(risk.positionLots), side === 0 ? LOTS : -LOTS, 'LIVE_AUDIT_ACTUAL_POSITION_MISMATCH')
      assert.ok(BigInt(risk.e0Q) < 0n || BigInt(risk.e1Q) < 0n, 'LIVE_AUDIT_POSITION_FULLY_BACKED')
      accounts.push({ owner, trader, risk })
    }
    const slacks = await read('coverageSlacks', [], number) as readonly bigint[]
    assert.equal(slacks.length, 2); assert.ok(slacks.every(value => value >= 0n), 'LIVE_AUDIT_NEGATIVE_COVERAGE')
    assert.equal(await read('recoveryEnabled', [], number), false, 'LIVE_AUDIT_RECOVERY_ENABLED')
    return { block, accounts, slacks }
  }
  const trade = await stateAt(BigInt(actors.trade.blockNumber), actors.trade.blockHash)
  const finalState = await stateAt(BigInt(snapshot.block.number), snapshot.block.hash)
  assert.ok(finalState.block.number >= trade.block.number, 'LIVE_AUDIT_SNAPSHOT_PRECEDES_TRADE')
  const demo = snapshot.markets.find(value => value.name === 'demo')!
  assert.ok(demo && same(demo.engine, market.engine), 'LIVE_AUDIT_SNAPSHOT_ENGINE')
  assert.equal(demo.reserveCoverage.recoveryEnabled, false)
  for (let side = 0; side < 2; side++) {
    compareRisk(trade.accounts[side].risk, actors.trade.accounts[side])
    assert.equal(BigInt(actors.trade.slacks[side]), trade.slacks[side], 'LIVE_AUDIT_REPORTED_COVERAGE_MISMATCH')
    assert.equal(BigInt(demo.reserveCoverage.slacks[side]), finalState.slacks[side], 'LIVE_AUDIT_SNAPSHOT_COVERAGE_MISMATCH')
    const account = demo.accounts.find(value => same(value.owner, LIVE_OWNERS[side]))
    assert.ok(account?.risk, 'LIVE_AUDIT_SNAPSHOT_OWNER_MISSING')
    compareRisk(finalState.accounts[side].risk, account.risk)
  }
  const custody = await read('balanceOf', [vault], finalState.block.number, token, erc20Abi) as bigint
  const recognized = await read('recognizedAtoms', [], finalState.block.number, vault, vaultAbi) as bigint
  assert.ok(custody >= recognized, 'LIVE_AUDIT_CUSTODY_DEFICIT')
  assert.equal(BigInt(snapshot.custodyAtoms), custody); assert.equal(BigInt(snapshot.recognizedAtoms), recognized)

  const allocations = [0n, 0n], releases = [0n, 0n]
  const placements: Array<{ side: number; receipt: ChainReceipt; tx: ChainTransaction }> = []
  const actorReceipts = []
  const mintAbi = parseAbi(['function mint(address owner, uint256 atoms)'])
  for (const entry of actors.receipts) {
    const hash = (entry.transactionHash ?? entry.hash)!
    const receipt = await client.getTransactionReceipt({ hash }), tx = await client.getTransaction({ hash })
    assert.ok(same(receipt.transactionHash, hash) && same(tx.hash, hash), 'LIVE_AUDIT_TRANSACTION_IDENTITY')
    assert.equal(receipt.status, 'success', 'LIVE_AUDIT_REVERTED')
    assert.equal(receipt.blockNumber, BigInt(entry.blockNumber)); assert.ok(same(receipt.blockHash, entry.blockHash))
    await canonical(receipt.blockNumber, receipt.blockHash)
    assert.ok(same(tx.from, entry.actor) && ACTORS.has(tx.from.toLowerCase()), 'LIVE_AUDIT_ACTOR_SUBSTITUTION')
    assert.equal(tx.value, 0n); assert.ok(tx.gas <= 30_000_000n, 'LIVE_AUDIT_GAS_CAP')
    assert.equal(receipt.gasUsed, BigInt(entry.gasUsed))
    if (entry.gasLimit !== undefined) assert.equal(tx.gas, BigInt(entry.gasLimit))
    let abi: Abi
    if (same(tx.to, market.engine)) abi = engineAbi
    else if (same(tx.to, vault)) abi = vaultAbi
    else if (same(tx.to, token)) abi = [...erc20Abi, ...mintAbi]
    else if (manifest.contracts.RolloverBatcher && same(tx.to, manifest.contracts.RolloverBatcher.address)) abi = RolloverBatcherAbi
    else throw new Error('LIVE_AUDIT_ACTOR_TARGET')
    const decoded = decodeFunctionData({ abi, data: tx.input })
    if (entry.action === 'rollover') assert.ok(['beginRollover', 'rollPage', 'finishRollover', 'rollover'].includes(decoded.functionName), 'LIVE_AUDIT_ROLLOVER_SELECTOR')
    else assert.equal(decoded.functionName, entry.action, 'LIVE_AUDIT_ACTOR_SELECTOR')
    const rolloverBatch = decoded.functionName === 'rollover'
      ? await auditRolloverBatch(manifest, market.engine, receipt, tx, entry.rolloverBatch, client) : undefined
    if (!rolloverBatch) assert.ok(!entry.rolloverBatch, 'LIVE_AUDIT_UNEXPECTED_BATCH_METADATA')
    const side = LIVE_OWNERS.findIndex(owner => same(tx.from, owner))
    if (side >= 0 && decoded.functionName === 'allocate') {
      assert.ok(same(String(decoded.args![0]), market.engine) && decoded.args![2] === false, 'LIVE_AUDIT_TRADER_ALLOCATION')
      allocations[side] += BigInt(String(decoded.args![1]))
    }
    if (side >= 0 && decoded.functionName === 'release') releases[side] += BigInt(String(decoded.args![0]))
    if (side >= 0 && decoded.functionName === 'placeOrder') {
      assert.ok(same(tx.to, market.engine), 'LIVE_AUDIT_TRADE_TARGET')
      const order = decoded.args![0] as { kind: number; isBuy: boolean; reduceOnly: boolean; tick: number; size: bigint; maxFills: number; expiryBlock: number }
      assert.deepEqual(order, { kind: side === 0 ? 1 : 0, isBuy: side === 0, reduceOnly: false,
        tick: actors.trade.tick, size: LOTS, maxFills: 8, expiryBlock: 0 }, 'LIVE_AUDIT_TRADE_CALLDATA')
      placements.push({ side, receipt, tx })
    }
    actorReceipts.push({ hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, from: tx.from, to: tx.to,
      operation: decoded.functionName, gasLimit: tx.gas, gasUsed: receipt.gasUsed, ...(rolloverBatch ? { rolloverBatch } : {}) })
  }
  assert.equal(placements.length, 2, 'LIVE_AUDIT_TWO_OWNER_ORDERS_REQUIRED')
  assert.equal(placements[0].side, 1); assert.equal(placements[1].side, 0)
  const buy = placements[1], sell = placements[0]
  assert.ok(sell.receipt.blockNumber <= buy.receipt.blockNumber && buy.receipt.blockNumber <= trade.block.number, 'LIVE_AUDIT_TRADE_ORDER')
  const fills = buy.receipt.logs.flatMap(log => {
    if (!same(log.address, market.engine)) return []
    try {
      const decoded = decodeEventLog({ abi: engineAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      return decoded.eventName === 'Fill' ? [decoded.args] : []
    } catch { return [] }
  })
  assert.equal(fills.length, 1, 'LIVE_AUDIT_MATCHED_FILL_REQUIRED')
  const fill = fills[0]
  assert.equal(fill.maker, trade.accounts[1].trader); assert.equal(fill.taker, trade.accounts[0].trader)
  assert.equal(fill.tick, actors.trade.tick); assert.equal(fill.size, LOTS)
  const notionalQ = LOTS * BigInt(fill.tick) * Q
  for (let side = 0; side < 2; side++) {
    const collateral = allocations[side] - releases[side]
    assert.ok(collateral > 0n, 'LIVE_AUDIT_NONPOSITIVE_TRADER_COLLATERAL')
    assert.equal(collateral, BigInt(actors.trade.collateralAtoms[side]), 'LIVE_AUDIT_COLLATERAL_FROM_TRANSACTIONS_MISMATCH')
    const expectedCash = collateral * Q + (side === 0 ? -notionalQ - fill.takerFeeQ : notionalQ - fill.makerFeeQ)
    assert.equal(BigInt(trade.accounts[side].risk.cashQ), expectedCash, 'LIVE_AUDIT_FILL_CASH_MISMATCH')
  }

  const sample = actors.postTradeSample
  assert.ok(pricefeed.samplerReceipts.some(value => same(value.hash ?? value.transactionHash, sample.transactionHash)), 'LIVE_AUDIT_POST_TRADE_SAMPLE_NOT_AUDITED')
  const sampleReceipt = await client.getTransactionReceipt({ hash: sample.transactionHash })
  const sampleTx = await client.getTransaction({ hash: sample.transactionHash })
  const sampleBlock = await canonical(sampleReceipt.blockNumber, sampleReceipt.blockHash)
  assert.equal(sampleReceipt.status, 'success'); assert.equal(sampleReceipt.blockNumber, BigInt(sample.blockNumber))
  assert.ok(same(sampleReceipt.blockHash, sample.blockHash) && same(sampleTx.from, SAMPLER) && same(sampleTx.to, market.engine), 'LIVE_AUDIT_SAMPLE_IDENTITY')
  assert.equal(sampleTx.value, 0n); assert.ok(sampleTx.gas <= 30_000_000n)
  assert.equal(decodeFunctionData({ abi: engineAbi, data: sampleTx.input }).functionName, 'samplePerp')
  assert.ok(sampleReceipt.blockNumber > buy.receipt.blockNumber, 'LIVE_AUDIT_SAMPLE_PRECEDES_TRADE')
  const observations = sampleReceipt.logs.flatMap(log => {
    if (!same(log.address, market.engine)) return []
    try {
      const event = decodeEventLog({ abi: engineAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      return event.eventName === 'PerpObservationRecorded' ? [event.args] : []
    } catch { return [] }
  })
  const observed = observations.find(value => value.valid && value.t === BigInt(sample.observation.t))
  assert.ok(observed, 'LIVE_AUDIT_VALID_POST_TRADE_EVENT_REQUIRED')
  for (const name of ['t', 'midWad', 'basisWad'] as const) assert.equal(observed[name], BigInt(sample.observation[name]))
  assert.equal(sample.observation.valid, true); assert.equal(observed.basisValid, sample.observation.basisValid)
  const matchedAt = (await canonical(buy.receipt.blockNumber, buy.receipt.blockHash)).timestamp
  assert.ok(observed.t >= matchedAt && observed.t <= sampleBlock.timestamp, 'LIVE_AUDIT_SAMPLE_CAPTURE_PRECEDES_TRADE')
  // Recheck both state checkpoints after all queries; a changed canonical block invalidates the proof.
  for (const block of [trade.block, finalState.block, sampleBlock]) {
    assert.equal((await client.getBlock({ blockNumber: block.number })).hash, block.hash, 'LIVE_AUDIT_REORGED_DURING_READ')
  }
  return { mode: 'LOCAL_LIVE_STATE_AUDIT', passed: true, chainId: 31337, publicTransactions: 0,
    engine: market.engine, listingHash: market.listingHash, trade, finalState, custodyAtoms: custody, recognizedAtoms: recognized,
    actorReceipts, uniqueActorPublisherSamplerReceipts: uniqueReceipts,
    actualMatchedFill: { hash: buy.receipt.transactionHash, blockNumber: buy.receipt.blockNumber, blockHash: buy.receipt.blockHash, ...fill },
    actualPostTradeSample: { hash: sampleReceipt.transactionHash, block: sampleBlock, observation: observed },
    collateralAndCashVerifiedFromTransactions: true, canonicalOwnerStatesVerified: true }
}

if (import.meta.main) {
  const [manifestPath, actorsPath, snapshotPath, pricefeedPath, output] = process.argv.slice(2)
  if (!manifestPath || !actorsPath || !snapshotPath || !pricefeedPath || !output) throw new Error('Usage: audit-live.ts manifest actors snapshot pricefeed-audit output')
  const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  const manifest = manifestSchema.parse(load(manifestPath)); assertLocalRpc(manifest.rpcUrl)
  const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }), cacheTime: 0 })
  const result = await auditLiveState(manifest, load(actorsPath), load(snapshotPath), load(pricefeedPath), client as unknown as AuditClient)
  const inputSha256 = Object.fromEntries(Object.entries({ manifest: manifestPath, actors: actorsPath, snapshot: snapshotPath, pricefeed: pricefeedPath })
    .map(([name, path]) => [name, createHash('sha256').update(readFileSync(path)).digest('hex')]))
  writeFileSync(output, json({ ...result, inputSha256 }) + '\n', { flag: 'wx' })
  console.log(json({ passed: true, canonicalOwnerStatesVerified: true, actorReceipts: result.actorReceipts.length, publicTransactions: 0 }))
}
