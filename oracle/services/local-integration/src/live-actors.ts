/** Owned-Anvil actors for the real-source experiment. Never imports public signing inputs. */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, parseAbiItem, type Abi, type Address } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { assertLocalRpc, manifestSchema } from './read-model'
import { atomicJson as save } from './atomic-json'
import { viemTransport } from '../../market-ops/src/chain'
import { Operations } from '../../market-ops/src/operations'
import { binding, manifestSchema as operationsSchema } from '../../market-ops/src/schema'
import { FileStore } from '../../market-ops/src/store'
import { broadcastTracked } from '../../market-ops/src/broadcast'

const Q = 10n ** 18n
const LOTS = 100_000n
export function ceilAtoms(value: bigint) {
  if (value < 0n) throw new Error('NEGATIVE_COLLATERAL_REQUIREMENT')
  return (value + Q - 1n) / Q
}
export function quoteTicks(indexWad: bigint, bandWad: bigint): [number, number] {
  if (indexWad <= 0n || indexWad >= Q || bandWad < 2n * 10n ** 15n) throw new Error('LIVE_QUOTE_RANGE_INVALID')
  const mid = Number(indexWad / 10n ** 15n)
  const half = Math.max(1, Math.min(5, Number(bandWad / (4n * 10n ** 15n))))
  if (mid - half < 1 || mid + half > 999) throw new Error('LIVE_PRICE_TOO_CLOSE_TO_ENDPOINT')
  return [mid - half, mid + half]
}
export function liveCollateralAtoms(preview: { requiredImQ: bigint; feeCapQ: bigint }, isBuy: boolean,
  markWad: bigint, tick: number, lots: bigint) {
  if (!Number.isInteger(tick) || tick < 1 || tick > 999 || lots <= 0n
    || preview.requiredImQ < 0n || preview.feeCapQ < 0n || markWad <= 0n || markWad >= Q) throw new Error('LIVE_MARGIN_INPUT_INVALID')
  const execution = BigInt(tick) * 10n ** 15n
  const adverse = isBuy ? execution - markWad : markWad - execution
  const required = preview.requiredImQ + preview.feeCapQ + (adverse > 0n ? lots * 1000n * adverse : 0n)
  return ceilAtoms(required) + 10000n // Explicit 0.01-token execution cushion.
}
/** Receipt order alone cannot establish when the book observation was captured. */
export function isPostTradeSample(sample: unknown, trade: { blockNumber: bigint | number | string; timestamp: bigint | number | string }) {
  if (!sample || typeof sample !== 'object') return false
  const value = sample as { blockNumber?: unknown; observation?: { valid?: unknown; t?: unknown } }
  if (value.observation?.valid !== true) return false
  const integer = (input: unknown) => {
    if (typeof input === 'bigint') return input
    if (typeof input === 'number' && Number.isSafeInteger(input)) return BigInt(input)
    if (typeof input === 'string' && /^(0|[1-9][0-9]*)$/.test(input)) return BigInt(input)
    throw new Error('INVALID_SAMPLE_TIME')
  }
  try {
    return integer(value.blockNumber) > integer(trade.blockNumber) && integer(value.observation.t) >= integer(trade.timestamp)
  } catch { return false }
}
/** An acknowledgement from before the latest resume cannot authorize book mutations. */
export function isSamplingPauseAcknowledged(report: unknown, requestId: string) {
  if (!report || typeof report !== 'object' || !requestId) return false
  const value = report as { samplingPaused?: unknown; samplingPauseRequestId?: unknown }
  return value.samplingPaused === true && value.samplingPauseRequestId === requestId
}
// Unchanged protocol carry (30s) minus observed begin-to-finish (11s) and 4s scheduling margin.
export const BOOTSTRAP_ROLLOVER_MAX_CAPTURE_AGE = 15n
export type BootstrapRolloverGate = 'unneeded' | 'wait-for-seal' | 'pause-for-boundary' | 'expired'
/** Only a capture sealed before epoch expiry can carry through the accounting sweep. */
export function bootstrapRolloverGate(state: {
  timestamp: bigint; epochEnd: bigint; pricingMode: number; work: number; pending: boolean; establishedLiquidity: boolean
}, sample: unknown): BootstrapRolloverGate {
  // Reconcile signed work and complete sweeps without waiting for impossible new book depth.
  // An initial epoch with no successful maker/seal history needs to roll before liquidity can be established.
  if (state.pending || state.work !== 0 || state.pricingMode !== 0 || !state.establishedLiquidity
    || state.timestamp + 30n < state.epochEnd) return 'unneeded'
  const value = sample as { observation?: { valid?: unknown; t?: unknown } } | null
  let captured: bigint | undefined
  try {
    const raw = value?.observation?.t
    if (value?.observation?.valid === true && ((typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw))
      || typeof raw === 'bigint' || (typeof raw === 'number' && Number.isSafeInteger(raw)))) captured = BigInt(raw)
  } catch { /* Malformed or missing publisher evidence cannot authorize rollover. */ }
  if (captured !== undefined && captured >= 0n && captured <= state.timestamp && captured < state.epochEnd
    && state.timestamp - captured <= BOOTSTRAP_ROLLOVER_MAX_CAPTURE_AGE
    && captured + BOOTSTRAP_ROLLOVER_MAX_CAPTURE_AGE >= state.epochEnd) return 'pause-for-boundary'
  // Effective accounting state is already SWEEP after epochEnd: waiting for a new seal would deadlock.
  return state.timestamp >= state.epochEnd ? 'expired' : 'wait-for-seal'
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

export async function runLiveActors(manifestPath: string, reportPath: string, controlPath: string, publisherPath: string, seconds = 7200) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('LIVE_DURATION_OUT_OF_BOUNDS')
  const manifest = manifestSchema.parse(readJson(manifestPath))
  assertLocalRpc(manifest.rpcUrl)
  const chain = defineChain({ id: 31337, name: 'owned-live-source-anvil', nativeCurrency: { name: 'TEST', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [manifest.rpcUrl] } } })
  const transport = http(manifest.rpcUrl, { timeout: 10000, retryCount: 0, fetchOptions: { redirect: 'error' } })
  const client = createPublicClient({ chain, transport, cacheTime: 0 })
  if (await client.getChainId() !== 31337 || !(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('OWNED_ANVIL_ONLY')
  const market = manifest.markets.find(value => value.name === 'demo')!
  const artifact = (name: string): Abi => JSON.parse(readFileSync(new URL(`../../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi
  const abi = artifact('RegistryBookRiskEngine'), vaultAbi = artifact('CollateralVault'), tokenAbi = artifact('MockUSDC')
  const read = (name: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<any> => client.readContract({ address: market.engine, abi, functionName: name, args, blockNumber })
  if (keccak256((await client.getCode({ address: market.engine }))!) !== market.codehash || await read('listingHash') !== market.listingHash) throw new Error('LIVE_ENGINE_IDENTITY_MISMATCH')
  const listing = await read('listing')
  const vault = manifest.contracts.CollateralVault.address, token = manifest.contracts.CollateralToken.address
  const account = (index: number) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: index })
  const report: any = existsSync(reportPath) ? readJson(reportPath) : { scope: 'local-only', sourceMode: 'polymarket', receipts: [], complete: false, publicTransactions: 0 }
  if ((report.engine && report.engine !== market.engine) || (report.listingHash && report.listingHash !== market.listingHash)) throw new Error('LIVE_ACTOR_JOURNAL_BINDING_MISMATCH')
  report.engine = market.engine; report.listingHash = market.listingHash
  const openings = await client.getLogs({ address: market.engine, fromBlock: BigInt(market.deployBlock), toBlock: 'latest',
    event: parseAbiItem('event EpochOpened(uint64 indexed epoch, uint64 start, uint64 end, int256 rateQPerLotSec, uint256 budgetQ)') })
  if (!openings[0]?.blockNumber) throw new Error('LIVE_ACTIVATION_EVENT_MISSING')
  const activation = await client.getBlock({ blockNumber: openings[0].blockNumber })
  if (activation.hash !== openings[0].blockHash) throw new Error('LIVE_ACTIVATION_REORG')
  report.activation = { blockNumber: activation.number, blockHash: activation.hash, timestamp: activation.timestamp }
  const deadline = Number(activation.timestamp) * 1000 + seconds * 1000
  report.deadlineMs = deadline
  const persist = () => save(reportPath, report)
  async function settlePending() {
    const pending = report.pending
    if (!pending) return
    if (keccak256(pending.rawTransaction) !== pending.hash) throw new Error('LIVE_SIGNED_BYTES_CHANGED')
    await broadcastTracked(pending.rawTransaction, client)
    const receipt = await client.waitForTransactionReceipt({ hash: pending.hash, timeout: 30000, pollingInterval: 200 })
    if (receipt.status !== 'success') throw new Error(`LIVE_ACTOR_REVERT:${pending.action}`)
    for (let n = 0; n < 80; ++n) {
      if ((await client.getBlock({ blockTag: 'finalized' })).number >= receipt.blockNumber) break
      if (n === 79) throw new Error('LIVE_ACTOR_FINALITY_TIMEOUT')
      await delay(200)
    }
    if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('LIVE_ACTOR_REORG')
    report.receipts.push({ transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, gasLimit: pending.gas, actor: pending.actor, action: pending.action })
    delete report.pending; persist()
  }
  async function send(index: number, address: Address, targetAbi: Abi, functionName: string, args: readonly unknown[] = []) {
    await settlePending()
    const owner = account(index), wallet = createWalletClient({ account: owner, chain, transport })
    if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_CHANGED')
    const head = await client.getBlock()
    const request = { address, abi: targetAbi, functionName, args, account: owner, blockNumber: head.number }
    const estimate = await client.estimateContractGas(request)
    const gas = (estimate * 150n + 99n) / 100n + 10000n
    if (gas > 30000000n) throw new Error('LIVE_ACTOR_GAS_CAP')
    await client.simulateContract({ ...request, gas })
    if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('LIVE_ACTOR_SIMULATION_REORG')
    const tx = await wallet.prepareTransactionRequest({ to: address, data: encodeFunctionData({ abi: targetAbi, functionName, args }), gas })
    const rawTransaction = await wallet.signTransaction(tx)
    report.pending = { hash: keccak256(rawTransaction), rawTransaction, gas, actor: owner.address, action: functionName }
    persist(); await settlePending()
  }
  async function pauseSampling(paused: boolean, boundary?: { minimumCaptureTime: bigint; epochEnd: bigint }) {
    const pauseRequestId = paused ? randomUUID() : undefined
    save(controlPath, { pauseSampling: paused, ...(pauseRequestId ? { pauseRequestId } : {}), ...(boundary ?? {}) })
    if (!paused) return
    // An armed boundary request starts up to 30s early; it must never wait beyond
    // that boundary or extend the original activation-anchored experiment budget.
    const pauseDeadline = boundary ? Math.min(Number(boundary.epochEnd) * 1000, deadline, Date.now() + 35000) : Date.now() + 20000
    while (!stopped && Date.now() < pauseDeadline) {
      try { if (isSamplingPauseAcknowledged(readJson(publisherPath), pauseRequestId!)) return } catch {}
      await delay(100)
    }
    if (stopped || Date.now() >= deadline) throw new Error(stopped ? 'LIVE_ACTORS_STOPPED' : 'LIVE_TIME_BUDGET_EXHAUSTED')
    if (boundary) throw new Error('LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE')
    throw new Error('LIVE_SAMPLER_PAUSE_TIMEOUT')
  }
  const operator = account(12)
  const rolloverHelper = manifest.contracts.RolloverBatcher
  if (!rolloverHelper) throw new Error('LIVE_ROLLOVER_HELPER_NOT_ENROLLED')
  const opsManifest = operationsSchema.parse({ chainId: 31337, engine: market.engine, engineCodeHash: market.codehash, listingHash: market.listingHash, marketId: market.marketId, oracle: manifest.contracts.ResolutionOracle.address, oracleCodeHash: manifest.contracts.ResolutionOracle.codehash, sender: operator.address,
    rolloverHelper: { address: rolloverHelper.address, codeHash: rolloverHelper.codehash, maxPages: 32, gasCeiling: 30_000_000 }, gas: {} })
  const opsTransport = viemTransport(opsManifest, manifest.rpcUrl, `0x${Buffer.from(operator.getHdKey().privateKey!).toString('hex')}`)
  const store = new FileStore(reportPath + '.rollover-journal.json', binding(opsManifest))
  const ops = new Operations(opsManifest, opsTransport, store)
  let quoteEpoch: bigint | undefined
  let quotes: [number, number] | undefined
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    await settlePending()
    if (!report.funded) {
      await pauseSampling(true)
      for (const index of [16, 17, 13, 14]) {
        const owner = account(index)
        if (await read('participantId', [owner.address]) !== 0) throw new Error('LIVE_ACTOR_PARTIAL_SETUP_REQUIRES_REVIEW')
        const atoms = index >= 16 ? 2000_000000n : 100_000000n
        await send(0, token, tokenAbi, 'mint', [owner.address, atoms])
        await send(index, token, tokenAbi, 'approve', [vault, atoms])
        await send(index, vault, vaultAbi, 'deposit', [atoms])
        await send(index, vault, vaultAbi, 'allocate', [market.engine, atoms, false])
      }
      report.funded = true; persist(); await pauseSampling(false)
    }
    while (!stopped && Date.now() < deadline) {
      let block = await client.getBlock(), risk = await read('marketRiskView', [], block.number)
      let work = Number(await read('work', [], block.number)), epoch = await read('epoch', [], block.number)
      let orderEpoch = BigInt(await read('marketOrderEpoch', [], block.number))
      report.state = { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, risk, work, epoch, orderEpoch }
      const latestSample = readJson(publisherPath).latestValidSample
      if (report.quotes && latestSample?.observation?.valid === true) report.bootstrapLiquidityEstablished = true
      let boundaryPaused = false
      if (!store.read().pending && work === 0 && Number(risk.pricingMode) === 0 && block.timestamp + 30n >= epoch[2]) {
        const [index, perp, basis] = await Promise.all([
          read('indexTwap300', [block.timestamp], block.number), read('perpTwap60', [block.timestamp], block.number),
          read('basisTwap900', [block.timestamp], block.number),
        ])
        if (index.available && perp.available && basis.available) report.matureBootstrapEpoch = epoch[0]
        report.rolloverReadiness = { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
          epochId: epoch[0], epochEnd: epoch[2], index, perp, basis,
          mode: report.bootstrapLiquidityEstablished ? 'established-bootstrap' : 'cold-bootstrap' }
      }
      const gateState = () => ({ timestamp: block.timestamp, epochEnd: BigInt(epoch[2]), pricingMode: Number(risk.pricingMode),
        work, pending: !!store.read().pending, establishedLiquidity: report.bootstrapLiquidityEstablished === true })
      const initialGate = bootstrapRolloverGate(gateState(), latestSample)
      if (initialGate !== 'unneeded') {
        report.rolloverGate = { decision: initialGate, blockNumber: block.number, timestamp: block.timestamp, epochEnd: epoch[2] }
        if (initialGate === 'expired') throw new Error('LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE')
        persist()
        await pauseSampling(true, { minimumCaptureTime: BigInt(epoch[2]) - BOOTSTRAP_ROLLOVER_MAX_CAPTURE_AGE, epochEnd: BigInt(epoch[2]) })
        boundaryPaused = true
        // Recheck after the publisher drained the current request, then retain that
        // seal through the boundary. The activation-anchored budget still applies.
        while (!stopped && Date.now() < deadline) {
          block = await client.getBlock()
          ;[risk, work, epoch, orderEpoch] = await Promise.all([
            read('marketRiskView', [], block.number), read('work', [], block.number),
            read('epoch', [], block.number), read('marketOrderEpoch', [], block.number),
          ])
          work = Number(work); orderEpoch = BigInt(orderEpoch)
          if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('LIVE_ROLLOVER_GATE_REORG')
          const sample = readJson(publisherPath).latestValidSample
          const decision = bootstrapRolloverGate(gateState(), sample)
          report.rolloverGate = { decision, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
            epochEnd: epoch[2], observation: sample?.observation }
          if (decision === 'expired') throw new Error('LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE')
          if (decision === 'wait-for-seal') throw new Error('LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE')
          if (decision === 'unneeded' || block.timestamp >= epoch[2]) break
          await delay(100)
        }
        if (stopped || Date.now() >= deadline) throw new Error(stopped ? 'LIVE_ACTORS_STOPPED' : 'LIVE_TIME_BUDGET_EXHAUSTED')
      }
      if (store.read().pending || work !== 0 || block.timestamp >= epoch[2]) {
        if (!boundaryPaused) await pauseSampling(true)
        for (const fn of opsManifest.rolloverHelper ? [] : ['beginRollover', 'rollPage', 'finishRollover'] as const) {
          try {
            const estimate = await client.estimateContractGas({ address: market.engine, abi, functionName: fn, args: fn === 'rollPage' ? [32] : [], account: operator, blockNumber: block.number })
            opsManifest.gas[fn] = Number((estimate * 150n + 99n) / 100n + 10000n)
          } catch { /* Only the currently executable step can be measured. */ }
        }
        if (boundaryPaused && !store.read().pending && work === 0) {
          const readyHead = await client.getBlock()
          const decision = bootstrapRolloverGate({ ...gateState(), timestamp: readyHead.timestamp }, readJson(publisherPath).latestValidSample)
          if (decision !== 'pause-for-boundary') throw new Error('LIVE_BOOTSTRAP_ROLLOVER_SAMPLE_UNAVAILABLE')
          report.rolloverGate.beginCheck = { blockNumber: readyHead.number, blockHash: readyHead.hash, timestamp: readyHead.timestamp }
        }
        report.rollover = await ops.tick({ action: 'rollover' }, true)
        if (report.rollover.outcome === 'finalized' && report.rollover.hash) {
          const receipt = await client.getTransactionReceipt({ hash: report.rollover.hash })
          if (receipt.status !== 'success' || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('LIVE_ROLLOVER_RECEIPT_INVALID')
          report.receipts.push({ transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, actor: operator.address, action: 'rollover',
            ...(report.rollover.rolloverBatch ? { rolloverBatch: report.rollover.rolloverBatch } : {}) })
        }
        quotes = undefined; quoteEpoch = undefined; persist(); await delay(300); continue
      }
      if (!risk.indexAvailable) { persist(); await delay(1000); continue }
      const indexWad = BigInt(risk.indexWad), band = BigInt(listing.bootstrapBandWad)
      const refresh = !quotes || quoteEpoch !== orderEpoch || quotes.some(tick => {
        const difference = BigInt(tick) * 10n ** 15n - indexWad
        return (difference < 0n ? -difference : difference) * 2n > band
      })
      if (refresh) {
        await pauseSampling(true)
        quotes = quoteTicks(indexWad, band)
        for (let side = 0; side < 2; ++side) {
          await send(16 + side, market.engine, abi, 'cancelAll')
          await send(16 + side, market.engine, abi, 'placeOrder', [{ kind: 2, isBuy: side === 0, reduceOnly: false, tick: quotes[side], size: BigInt(listing.depthNLots), maxFills: 8, expiryBlock: 0 }])
        }
        quoteEpoch = orderEpoch; report.quotes = { ticks: quotes, orderEpoch, timestamp: block.timestamp }; persist()
        await pauseSampling(false); continue
      }
      await pauseSampling(false)
      const caps = await read('leverageCaps')
      if (!report.trade && risk.markAvailable && risk.pricingMode === 1 && caps[0] === 5n && caps[1] === 5n) {
        // Flat-owner collateral moves happen while sampling continues. Pausing across
        // four finalized transactions would consume the unchanged 30-second mark carry.
        const fundingTick = Number((BigInt(risk.markWad) + 5n * 10n ** 14n) / 10n ** 15n)
        let changedMargin = false
        const preparedOwners = new Set<number>(report.marginPrepared?.owners ?? [])
        for (let side = 0; side < 2; ++side) {
          const trader = await read('participantId', [account(13 + side).address])
          const preview = await read('previewOrder', [trader, side, fundingTick, LOTS, false])
          const ownerRisk = await read('accountRiskView', [trader])
          if (ownerRisk.positionLots !== 0n) throw new Error('LIVE_PARTIAL_TRADE_REQUIRES_REVIEW')
          const allocated = BigInt(ownerRisk.cashQ) / Q
          if (preview.fullBackingRequired || preview.acceptedCapLots !== LOTS || preview.rejection !== 0) {
            // A preview with a halved cap reports IM for the smaller cap. Restore
            // the flat owner's existing free funds before requesting a full preview.
            if (preparedOwners.has(side) && allocated < 100_000000n) {
              await send(13 + side, vault, vaultAbi, 'allocate', [market.engine, 100_000000n - allocated, false])
              preparedOwners.delete(side); changedMargin = true
            }
            continue
          }
          const atoms = liveCollateralAtoms(preview, side === 0, BigInt(risk.markWad), fundingTick, LOTS)
          const worstAtoms = LOTS * BigInt(side === 0 ? fundingTick : 1000 - fundingTick)
          if (atoms >= worstAtoms) throw new Error('LIVE_PREVIEW_REQUIRES_FULL_BACKING')
          if (!preparedOwners.has(side) && allocated > atoms) {
            await send(13 + side, market.engine, abi, 'release', [allocated - atoms]); changedMargin = true
          } else if (allocated < atoms) {
            await send(13 + side, vault, vaultAbi, 'allocate', [market.engine, atoms - allocated, false]); changedMargin = true
          }
          if (!preparedOwners.has(side)) { preparedOwners.add(side); changedMargin = true }
        }
        if (changedMargin) {
          report.marginPrepared = { blockNumber: (await client.getBlock()).number, owners: [...preparedOwners] }
          persist(); continue
        }
        if (preparedOwners.size !== 2) { persist(); await delay(500); continue }
        const publisher = readJson(publisherPath)
        const sample = publisher.latestValidSample
        const observed = sample?.observation?.t ?? sample?.timestamp
        if (observed === undefined || block.timestamp < BigInt(observed) || block.timestamp - BigInt(observed) > 18n
          || (report.marginPrepared && BigInt(sample.blockNumber) <= BigInt(report.marginPrepared.blockNumber))) { persist(); await delay(500); continue }
        await pauseSampling(true)
        const current = await read('marketRiskView')
        const tick = Number((BigInt(current.markWad) + 5n * 10n ** 14n) / 10n ** 15n)
        if (!current.markAvailable || !quotes || tick <= quotes[0] || tick >= quotes[1]) { await pauseSampling(false); await delay(500); continue }
        const collaterals: bigint[] = []
        let ready = true
        for (let side = 0; side < 2; ++side) {
          const trader = await read('participantId', [account(13 + side).address])
          const preview = await read('previewOrder', [trader, side, tick, LOTS, false])
          if (preview.fullBackingRequired || preview.acceptedCapLots !== LOTS || preview.rejection !== 0) { ready = false; break }
          const atoms = liveCollateralAtoms(preview, side === 0, BigInt(current.markWad), tick, LOTS)
          const worstAtoms = side === 0 ? LOTS * BigInt(tick) : LOTS * BigInt(1000 - tick)
          if (atoms >= worstAtoms) throw new Error('LIVE_PREVIEW_REQUIRES_FULL_BACKING')
          const allocated = BigInt((await read('accountRiskView', [trader])).cashQ) / Q
          if (allocated < atoms) { ready = false; break }
          if (allocated >= worstAtoms) throw new Error('LIVE_OWNER_IS_STILL_FULLY_BACKED')
          collaterals.push(allocated)
        }
        if (!ready) { await pauseSampling(false); await delay(500); continue }
        await send(14, market.engine, abi, 'placeOrder', [{ kind: 0, isBuy: false, reduceOnly: false, tick, size: LOTS, maxFills: 8, expiryBlock: 0 }])
        await send(13, market.engine, abi, 'placeOrder', [{ kind: 1, isBuy: true, reduceOnly: false, tick, size: LOTS, maxFills: 8, expiryBlock: 0 }])
        const tradeBlock = await client.getBlock()
        const positions = []
        for (let side = 0; side < 2; ++side) {
          const raw = await read('accountRiskView', [await read('participantId', [account(13 + side).address], tradeBlock.number)], tradeBlock.number)
          if (raw.positionLots !== (side === 0 ? LOTS : -LOTS) || (raw.e0Q >= 0n && raw.e1Q >= 0n)) throw new Error('LIVE_MINED_LEVERAGE_MISMATCH')
          positions.push(raw)
        }
        const slacks = await read('coverageSlacks', [], tradeBlock.number)
        if (slacks[0] < 0n || slacks[1] < 0n || await read('recoveryEnabled', [], tradeBlock.number)) throw new Error('LIVE_RESERVE_COVERAGE_FAILED')
        if ((await client.getBlock({ blockNumber: tradeBlock.number })).hash !== tradeBlock.hash) throw new Error('LIVE_TRADE_STATE_REORG')
        report.trade = { tick, lots: LOTS, collateralAtoms: collaterals, accounts: positions, slacks, blockNumber: tradeBlock.number, blockHash: tradeBlock.hash, timestamp: tradeBlock.timestamp }
        persist(); await pauseSampling(false)
      }
      if (report.trade) {
        const sample = readJson(publisherPath).latestValidSample
        if (isPostTradeSample(sample, report.trade)) { report.complete = true; report.postTradeSample = sample; persist(); return }
      }
      persist(); await delay(1000)
    }
    throw new Error(stopped ? 'LIVE_ACTORS_STOPPED' : 'LIVE_TIME_BUDGET_EXHAUSTED')
  } finally { store.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); persist() }
}

if (import.meta.main) {
  const [manifest, report, control, publisher, duration = '7200'] = process.argv.slice(2)
  if (!manifest || !report || !control || !publisher) throw new Error('Usage: live-actors manifest report control publisher [seconds]')
  await runLiveActors(resolve(manifest), resolve(report), resolve(control), resolve(publisher), Number(duration))
}
