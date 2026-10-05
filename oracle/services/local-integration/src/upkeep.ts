import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, keccak256, parseTransaction, recoverTransactionAddress, stringToHex, TransactionReceiptNotFoundError, type Abi, type Address, type Hex, type TransactionSerialized } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { z } from 'zod'
import { assertLocalRpc, json, manifestSchema } from './read-model'
import { broadcastTracked } from '../../market-ops/src/broadcast'

const counter = z.string().regex(/^(0|[1-9][0-9]*)$/)
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as Hex)
const actor = z.enum(['operator', 'buyer', 'seller'])
const action = z.enum(['beginRollover', 'rollPage', 'finishRollover', 'quote'])
const memorySchema = z.object({
  marketOrderEpoch: counter, initialized: z.boolean(), orders: z.object({ buyer: z.number().int().nonnegative(), seller: z.number().int().nonnegative() }),
  quoteEpoch: counter.optional(), quoted: z.array(z.enum(['buyer', 'seller'])),
}).strict()
const pendingSchema = z.object({
  market: z.enum(['demo', 'terminal']), action, actor, hash,
  rawTransaction: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).transform(value => value as Hex),
  data: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).transform(value => value as Hex),
  gasLimit: z.number().int().positive().max(30_000_000), estimate: counter, plannedBlock: counter,
}).strict()
const journalSchema = z.object({
  version: z.literal(1), binding: hash, markets: z.record(z.enum(['demo', 'terminal']), memorySchema),
  pending: pendingSchema.optional(), receipts: z.array(z.record(z.string(), z.unknown())),
}).strict()
type Journal = z.infer<typeof journalSchema>
type Memory = z.infer<typeof memorySchema>
type Pending = z.infer<typeof pendingSchema>
export type UpkeepState = {
  timestamp: bigint; scheduledT: bigint; halted: boolean; work: number; epochEnd: bigint;
  cursor: bigint; count: bigint; marketOrderEpoch: bigint; indexAvailable: boolean; monitorRestricted: boolean;
}

export function upkeepGas(estimate: bigint): number {
  if (estimate <= 0n || estimate > 30_000_000n) throw new Error('LOCAL_UPKEEP_GAS_OUT_OF_BOUNDS')
  const padded = (estimate * 130n + 99n) / 100n + 10_000n
  return Number(padded > 30_000_000n ? 30_000_000n : padded)
}

export function planUpkeep(state: UpkeepState, memory: Memory, quotes: boolean): { action: Pending['action']; actor: Pending['actor'] } | null {
  if (state.halted || state.timestamp >= state.scheduledT) return null
  if (state.work === 0 && state.timestamp >= state.epochEnd) return { action: 'beginRollover', actor: 'operator' }
  if (state.work === 1) return { action: state.cursor < state.count ? 'rollPage' : 'finishRollover', actor: 'operator' }
  if (state.work !== 0 || !quotes || !memory.initialized || !memory.quoteEpoch || !state.indexAvailable || state.monitorRestricted) return null
  for (const owner of ['buyer', 'seller'] as const) if (!memory.quoted.includes(owner)) return { action: 'quote', actor: owner }
  return null
}

export class UpkeepStore {
  private lock: number
  constructor(private path: string, private binding: Hex) {
    mkdirSync(dirname(path), { recursive: true })
    this.lock = openSync(`${path}.lock`, 'wx', 0o600)
    writeFileSync(this.lock, `${process.pid}\n`)
    try { this.read() } catch (error) { this.close(); throw error }
  }
  read(): Journal {
    const initial = (): Memory => ({ marketOrderEpoch: '0', initialized: false, orders: { buyer: 0, seller: 0 }, quoted: [] })
    const value = existsSync(this.path) ? journalSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1 as const, binding: this.binding, markets: { demo: initial(), terminal: initial() }, receipts: [] }
    if (value.binding.toLowerCase() !== this.binding.toLowerCase()) throw new Error('LOCAL_UPKEEP_JOURNAL_BINDING_CHANGED')
    if (value.pending && keccak256(value.pending.rawTransaction) !== value.pending.hash) throw new Error('LOCAL_UPKEEP_SIGNED_BYTES_CHANGED')
    return value
  }
  write(value: Journal) {
    journalSchema.parse(value)
    if (value.binding !== this.binding) throw new Error('LOCAL_UPKEEP_JOURNAL_BINDING_CHANGED')
    const handle = openSync(`${this.path}.tmp`, 'w', 0o600)
    try { writeFileSync(handle, json(value) + '\n'); fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(`${this.path}.tmp`, this.path)
  }
  close() { closeSync(this.lock); unlinkSync(`${this.path}.lock`) }
}

export async function runLocalUpkeep(manifestPath: string, journalPath: string, reportPath: string, once = false) {
  const paths = [manifestPath, journalPath, reportPath].map(path => resolve(path))
  if (new Set(paths).size !== 3) throw new Error('LOCAL_UPKEEP_PATHS_MUST_DIFFER')
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(paths[0], 'utf8')))
  assertLocalRpc(manifest.rpcUrl)
  const chain = defineChain({ id: 31337, name: 'local-upkeep', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [manifest.rpcUrl] } } })
  const transport = http(manifest.rpcUrl, { timeout: 10000, retryCount: 0, fetchOptions: { redirect: 'error' } })
  const client = createPublicClient({ chain, transport })
  if (await client.getChainId() !== 31337 || !(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('LOCAL_ANVIL_ONLY')
  const accounts = Object.fromEntries([['operator', 12], ['buyer', 1], ['seller', 2]].map(([name, index]) =>
    [name, mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: index as number })])) as Record<Pending['actor'], ReturnType<typeof mnemonicToAccount>>
  for (const owner of ['buyer', 'seller'] as const) if (accounts[owner].address.toLowerCase() !== manifest.accounts[owner].toLowerCase()) throw new Error('LOCAL_FIXTURE_OWNER_MISMATCH')
  const abi = JSON.parse(readFileSync(new URL('../../../out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json', import.meta.url), 'utf8')).abi as Abi
  const registryAbi = JSON.parse(readFileSync(new URL('../../../out/MarketRegistry.sol/MarketRegistry.json', import.meta.url), 'utf8')).abi as Abi
  const markets = Object.fromEntries(manifest.markets.map(market => [market.name, market])) as Record<'demo' | 'terminal', typeof manifest.markets[number]>
  const binding = keccak256(stringToHex(json({ chainId: 31337, markets: manifest.markets, contracts: manifest.contracts, accounts: Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, account.address])) })))
  const store = new UpkeepStore(paths[1], binding)
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const read = (name: 'demo' | 'terminal', functionName: string, args: readonly unknown[], blockNumber: bigint) =>
    client.readContract({ address: markets[name].engine, abi, functionName, args, blockNumber })
  const snapshot = async (name: 'demo' | 'terminal') => {
    if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_CHANGED')
    const block = await client.getBlock()
    const market = markets[name]
    const [code, listingHash, listing, halt, work, epoch, cursor, count, orderEpoch, risk, core, registryCode] = await Promise.all([
      client.getCode({ address: market.engine, blockNumber: block.number }), read(name, 'listingHash', [], block.number), read(name, 'listing', [], block.number),
      read(name, 'getHaltSnapshot', [], block.number), read(name, 'work', [], block.number), read(name, 'epoch', [], block.number),
      read(name, 'cursor', [], block.number), read(name, 'sweepCount', [], block.number), read(name, 'marketOrderEpoch', [], block.number), read(name, 'marketRiskView', [], block.number),
      client.readContract({ address: manifest.contracts.MarketRegistry.address, abi: registryAbi, functionName: 'getMarketCore', args: [market.marketId], blockNumber: block.number }),
      client.getCode({ address: manifest.contracts.MarketRegistry.address, blockNumber: block.number }),
    ])
    const configuration = listing as { marketId: Hex; registry: Address; scheduledT: bigint }
    if (!code || keccak256(code) !== market.codehash || listingHash !== market.listingHash || configuration.marketId !== market.marketId
        || configuration.registry.toLowerCase() !== manifest.contracts.MarketRegistry.address.toLowerCase()
        || (core as { engine: Address }).engine.toLowerCase() !== market.engine.toLowerCase()
        || !registryCode || keccak256(registryCode) !== manifest.contracts.MarketRegistry.codehash) throw new Error('LOCAL_UPKEEP_IDENTITY_CHANGED')
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('LOCAL_UPKEEP_REORGED')
    const state: UpkeepState = { timestamp: block.timestamp, scheduledT: configuration.scheduledT, halted: (halt as { halted: boolean }).halted,
      work: Number(work), epochEnd: (epoch as readonly unknown[])[2] as bigint, cursor: cursor as bigint, count: count as bigint,
      marketOrderEpoch: orderEpoch as bigint, indexAvailable: (risk as { indexAvailable: boolean }).indexAvailable,
      monitorRestricted: (risk as { monitorRestricted: boolean }).monitorRestricted }
    return { block, state }
  }
  const discoverOrders = async (name: 'demo' | 'terminal', blockNumber: bigint) => {
    const start = BigInt(markets[name].deployBlock)
    if (blockNumber - start > 5000n) throw new Error('INITIAL_UPKEEP_DISCOVERY_REQUIRES_RECENT_DEPLOYMENT')
    const candidates: number[] = []
    for (let from = start; from <= blockNumber; from += 250n) {
      const logs = await client.getLogs({ address: markets[name].engine, fromBlock: from, toBlock: from + 249n < blockNumber ? from + 249n : blockNumber })
      for (const log of logs) {
        try {
          const event = decodeEventLog({ abi, topics: log.topics, data: log.data })
          if (event.eventName === 'OrderPlaced') candidates.push(Number((event.args as unknown as { id: number }).id))
        } catch {}
      }
    }
    if (candidates.length > 128) throw new Error('LOCAL_FIXTURE_ORDER_DISCOVERY_BOUND')
    const found = { buyer: 0, seller: 0 }
    for (const owner of ['buyer', 'seller'] as const) {
      const trader = Number(await read(name, 'participantId', [accounts[owner].address], blockNumber))
      for (const id of candidates) {
        const order = await read(name, 'getOrder', [id], blockNumber) as { owner: number; tick: number; size: bigint; flags: number }
        if (order.owner === trader && order.tick === (owner === 'buyer' ? 490 : 510) && order.size === 1000n && (order.flags & 4) !== 0) {
          if (found[owner]) throw new Error('AMBIGUOUS_LOCAL_FIXTURE_ORDER')
          found[owner] = id
        }
      }
      if (!found[owner]) throw new Error('LOCAL_FIXTURE_ORDER_NOT_FOUND')
    }
    return found
  }
  const argumentsFor = (pending: Pick<Pending, 'action' | 'actor' | 'market'>, journal: Journal) => {
    if (pending.action === 'rollPage') return [32]
    if (pending.action !== 'quote') return []
    if (pending.actor === 'operator') throw new Error('INVALID_QUOTE_OWNER')
    const old = journal.markets[pending.market].orders[pending.actor]
    return [old ? [old] : [], [{ kind: 2, isBuy: pending.actor === 'buyer', reduceOnly: false, tick: pending.actor === 'buyer' ? 490 : 510, size: 1000n, maxFills: 8, expiryBlock: 0 }]]
  }
  const writeReport = (journal: Journal, states: unknown) => {
    mkdirSync(dirname(paths[2]), { recursive: true })
    const result = { scope: 'local-only', chainId: 31337, operator: accounts.operator.address, mode: once ? 'bounded-maintenance-no-quotes' : 'fixture-epoch-maintenance', states,
      markets: journal.markets, pending: journal.pending ? { hash: journal.pending.hash, action: journal.pending.action, market: journal.pending.market } : null,
      receipts: journal.receipts, limitations: 'Real bounded accounting; explicit disposable fixture owners re-quote only after rollover. Not a public market maker.' }
    const temporary = `${paths[2]}.tmp`
    writeFileSync(temporary, json(result) + '\n')
    renameSync(temporary, paths[2])
  }
  try {
    await snapshot('demo')
    await snapshot('terminal')
    await (client.request as (value: { method: string; params: unknown[] }) => Promise<unknown>)({ method: 'anvil_setBalance', params: [accounts.operator.address, '0x3635c9adc5dea00000'] })
    let onceActions = 0
    do {
      const journal = store.read()
      const pending = journal.pending
      if (pending) {
        await snapshot(pending.market)
        const functionName = pending.action === 'quote' ? 'batch' : pending.action
        const data = encodeFunctionData({ abi, functionName, args: argumentsFor(pending, journal) })
        const transaction = parseTransaction(pending.rawTransaction)
        if (pending.data !== data || transaction.data !== data || transaction.to?.toLowerCase() !== markets[pending.market].engine.toLowerCase()
            || transaction.chainId !== 31337 || transaction.gas !== BigInt(pending.gasLimit) || (transaction.value ?? 0n) !== 0n
            || (await recoverTransactionAddress({ serializedTransaction: pending.rawTransaction as TransactionSerialized })).toLowerCase() !== accounts[pending.actor].address.toLowerCase()) throw new Error('LOCAL_UPKEEP_PENDING_BINDING_CHANGED')
        let receipt
        try { receipt = await client.getTransactionReceipt({ hash: pending.hash }) } catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error }
        if (!receipt) {
          if (await broadcastTracked(pending.rawTransaction, client) !== pending.hash) throw new Error('LOCAL_UPKEEP_BROADCAST_HASH_CHANGED')
        } else {
          const [canonical, finalized] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockTag: 'finalized' })])
          if (canonical.hash !== receipt.blockHash) throw new Error('LOCAL_UPKEEP_RECEIPT_REORGED')
          if (finalized.number >= receipt.blockNumber) {
            if (receipt.status !== 'success') throw new Error(`LOCAL_UPKEEP_TRANSACTION_REVERTED:${pending.hash}`)
            const memory = journal.markets[pending.market]
            if (pending.action === 'quote') {
              if (pending.actor === 'operator') throw new Error('INVALID_QUOTE_OWNER')
              const placed = receipt.logs.filter(log => log.address.toLowerCase() === markets[pending.market].engine.toLowerCase()).flatMap(log => {
                try { const event = decodeEventLog({ abi, topics: log.topics, data: log.data }); return event.eventName === 'OrderPlaced' ? [event] : [] } catch { return [] }
              })
              if (placed.length !== 1) throw new Error('LOCAL_FIXTURE_REQUOTE_NOT_ACCEPTED')
              memory.orders[pending.actor] = Number((placed[0].args as unknown as { id: number }).id)
              memory.quoted.push(pending.actor)
              if (memory.quoted.length === 2) { delete memory.quoteEpoch; memory.quoted = [] }
            }
            journal.receipts.push({ hash: pending.hash, market: pending.market, action: pending.action, actor: pending.actor,
              blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(),
              gasLimit: pending.gasLimit, estimate: pending.estimate, status: receipt.status })
            if (journal.receipts.length > 1000) throw new Error('LOCAL_UPKEEP_RECEIPT_LIMIT')
            delete journal.pending
            store.write(journal)
          }
        }
        writeReport(journal, { reconciling: pending.market })
      } else {
        const states: Record<string, unknown> = {}
        let planned = false
        for (const name of ['demo', 'terminal'] as const) {
          const { block, state } = await snapshot(name)
          states[name] = { blockNumber: block.number, blockHash: block.hash, ...state }
          const memory = journal.markets[name]
          if (state.halted || state.timestamp >= state.scheduledT) continue
          if (!once && !memory.initialized) { memory.orders = await discoverOrders(name, block.number); memory.initialized = true }
          if (memory.marketOrderEpoch !== state.marketOrderEpoch.toString()) {
            if (!once && memory.marketOrderEpoch !== '0') { memory.quoteEpoch = state.marketOrderEpoch.toString(); memory.quoted = [] }
            memory.marketOrderEpoch = state.marketOrderEpoch.toString()
          }
          store.write(journal)
          const next = planUpkeep(state, memory, !once)
          if (!next) continue
          if (once && ++onceActions > 72) throw new Error('LOCAL_UPKEEP_BOUNDED_ACTION_LIMIT')
          const functionName = next.action === 'quote' ? 'batch' : next.action
          const args = argumentsFor({ ...next, market: name }, journal)
          const account = accounts[next.actor]
          const call = { address: markets[name].engine, abi, functionName, args, account: account.address }
          await client.simulateContract({ ...call, blockNumber: block.number })
          const estimate = await client.estimateContractGas({ ...call, blockNumber: block.number })
          const gasLimit = upkeepGas(estimate)
          const [latestNonce, pendingNonce] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'latest' }), client.getTransactionCount({ address: account.address, blockTag: 'pending' })])
          if (latestNonce !== pendingNonce) throw new Error('LOCAL_UPKEEP_UNTRACKED_NONCE')
          const wallet = createWalletClient({ account, chain, transport })
          const data = encodeFunctionData({ abi, functionName, args })
          const request = await wallet.prepareTransactionRequest({ account, chain, to: markets[name].engine, data, gas: BigInt(gasLimit), nonce: latestNonce })
          const rawTransaction = await wallet.signTransaction(request)
          journal.pending = { market: name, ...next, hash: keccak256(rawTransaction), rawTransaction, data, gasLimit, estimate: estimate.toString(), plannedBlock: block.number.toString() }
          store.write(journal)
          if (await client.sendRawTransaction({ serializedTransaction: rawTransaction }) !== journal.pending.hash) throw new Error('LOCAL_UPKEEP_BROADCAST_HASH_CHANGED')
          planned = true
          break
        }
        writeReport(journal, states)
        if (once && !planned) break
      }
      await new Promise(delay => setTimeout(delay, manifest.riskScenario === 'leveraged-fixture' ? 200 : 1000))
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
  if (paths.length !== 3 || paths.some(value => value.startsWith('--'))) throw new Error('Usage: upkeep.ts manifest.json journal.json report.json [--once]')
  await runLocalUpkeep(paths[0], paths[1], paths[2], once)
}
