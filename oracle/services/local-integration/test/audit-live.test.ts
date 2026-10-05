import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from 'viem'
import { RegistryBookRiskEngineAbi as engineAbi, CollateralVaultAbi as vaultAbi } from '../../../packages/oracle-sdk/src/browser'
import { auditLiveState, assertUniqueReceiptSets, LIVE_OWNERS, type ActorsReport, type AuditClient, type PricefeedAudit, type SnapshotReport } from '../src/audit-live'
import { manifestSchema } from '../src/read-model'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const code = '0x600100' as Hex
const Q = 10n ** 24n
const engine = address(1)
const sampler = '0x71bE63f3384f5fb98995898A86B02Fb2426c5788' as Address
const manifest = manifestSchema.parse({ scope: 'local-only', chainId: 31337, sourceCommit: 'test', rpcUrl: 'http://127.0.0.1:18545',
  contracts: Object.fromEntries(['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken'].map((name, index) => [name, { address: address(index + 10), codehash: keccak256(code), deployBlock: 0 }])),
  markets: [{ name: 'demo', engine, marketId: hash(1), sourceId: hash(3), listingHash: hash(4), codehash: keccak256(code), deployBlock: 0 }],
  accounts: { leveragedLong: LIVE_OWNERS[0], leveragedShort: LIVE_OWNERS[1] },
})
const callData = (abi: Abi, functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi, functionName, args })
const block = (number: bigint) => ({ number, hash: hash(Number(number)), timestamp: 1000n + number })

function fixture() {
  const receipts = new Map<Hex, Awaited<ReturnType<AuditClient['getTransactionReceipt']>>>()
  const transactions = new Map<Hex, Awaited<ReturnType<AuditClient['getTransaction']>>>()
  const risks = [
    { trader: 1, cashQ: -40n * Q, positionLots: 100_000n, e0Q: -40n * Q, e1Q: 60n * Q },
    { trader: 2, cashQ: 60n * Q, positionLots: -100_000n, e0Q: 60n * Q, e1Q: -40n * Q },
  ]
  const slacks = [99960n * Q, 99960n * Q]
  const actors: ActorsReport = { complete: true, engine, listingHash: hash(4), receipts: [],
    trade: { tick: 500, lots: 100_000n, collateralAtoms: [10_000_000n, 10_000_000n], accounts: structuredClone(risks), slacks: [...slacks], blockNumber: 7n, blockHash: hash(7) },
    postTradeSample: { transactionHash: hash(108), blockNumber: 8n, blockHash: hash(8),
      observation: { t: 1007n, midWad: 5n * 10n ** 17n, valid: true, basisWad: 0n, basisValid: true } },
  }
  const snapshot: SnapshotReport = { block: block(9n), custodyAtoms: 100020000000n, recognizedAtoms: 100020000000n,
    markets: [{ name: 'demo', engine, reserveCoverage: { slacks: [...slacks], recoveryEnabled: false },
      accounts: LIVE_OWNERS.map((owner, i) => ({ owner, name: i === 0 ? 'leveragedLong' : 'leveragedShort', risk: structuredClone(risks[i]) })) }],
  }
  const pricefeed: PricefeedAudit = { passed: true, chainId: 31337, canonicalReceiptsVerified: true, config: { destination: { engineAddress: engine } },
    publisherReceipts: [{ hash: hash(190) }], samplerReceipts: [{ hash: hash(108) }] }
  const add = (number: number, owner: Address, to: Address, action: string, input: Hex, reported = true) => {
    const transactionHash = hash(100 + number)
    receipts.set(transactionHash, { transactionHash, blockNumber: BigInt(number), blockHash: hash(number), status: 'success', gasUsed: 21000n, logs: [] })
    transactions.set(transactionHash, { hash: transactionHash, from: owner, to, input, gas: 100000n, value: 0n })
    if (reported) actors.receipts.push({ transactionHash, blockNumber: BigInt(number), blockHash: hash(number), gasUsed: 21000n, gasLimit: 100000n, actor: owner, action })
  }
  add(1, LIVE_OWNERS[0], manifest.contracts.CollateralVault.address, 'allocate', callData(vaultAbi, 'allocate', [engine, 100_000_000n, false]))
  add(2, LIVE_OWNERS[0], engine, 'release', callData(engineAbi, 'release', [90_000_000n]))
  add(3, LIVE_OWNERS[1], manifest.contracts.CollateralVault.address, 'allocate', callData(vaultAbi, 'allocate', [engine, 100_000_000n, false]))
  add(4, LIVE_OWNERS[1], engine, 'release', callData(engineAbi, 'release', [90_000_000n]))
  add(5, LIVE_OWNERS[1], engine, 'placeOrder', callData(engineAbi, 'placeOrder', [{ kind: 0, isBuy: false, reduceOnly: false, tick: 500, size: 100_000n, maxFills: 8, expiryBlock: 0 }]))
  add(6, LIVE_OWNERS[0], engine, 'placeOrder', callData(engineAbi, 'placeOrder', [{ kind: 1, isBuy: true, reduceOnly: false, tick: 500, size: 100_000n, maxFills: 8, expiryBlock: 0 }]))
  const fillLog = () => ({ address: engine,
    topics: encodeEventTopics({ abi: engineAbi, eventName: 'Fill', args: { makerOrder: 12 } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }], [2, 1, 500, 100_000n, 0n, 0n]),
  })
  receipts.get(hash(106))!.logs = [fillLog()]
  add(8, sampler, engine, 'samplePerp', callData(engineAbi, 'samplePerp', []), false)
  const sampleLog = (t = 1007n, valid = true) => ({ address: engine,
    topics: encodeEventTopics({ abi: engineAbi, eventName: 'PerpObservationRecorded' }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }, { type: 'bool' }, { type: 'int256' }, { type: 'bool' }], [t, 5n * 10n ** 17n, valid, 0n, true]),
  })
  receipts.get(hash(108))!.logs = [sampleLog()]
  const reads: Array<{ functionName: string; blockNumber: bigint }> = []
  const client: AuditClient = {
    getChainId: async () => 31337,
    getBlock: async args => block('blockNumber' in args ? args.blockNumber : 100n),
    getCode: async () => code,
    getTransactionReceipt: async ({ hash }) => receipts.get(hash)!,
    getTransaction: async ({ hash }) => transactions.get(hash)!,
    readContract: async args => {
      reads.push(args)
      switch (args.functionName) {
        case 'listingHash': return hash(4)
        case 'collateralVault': return manifest.contracts.CollateralVault.address
        case 'getMarketCore': return { engine }
        case 'participantId': return args.args![0] === LIVE_OWNERS[0] ? 1 : 2
        case 'accountRiskView': return risks[Number(args.args![0]) - 1]
        case 'coverageSlacks': return slacks
        case 'recoveryEnabled': return false
        case 'balanceOf': case 'recognizedAtoms': return 100020000000n
        default: throw new Error(`Unexpected read ${args.functionName}`)
      }
    },
  }
  return { actors, snapshot, pricefeed, client, receipts, transactions, risks, reads, sampleLog,
    run: () => auditLiveState(manifest, actors, snapshot, pricefeed, client) }
}

describe('live proof canonical state reconciliation', () => {
  test('reconciles independently funded owner positions, fill cash, custody and a later valid sample at pinned blocks', async () => {
    const f = fixture(), result = await f.run()
    expect(result.canonicalOwnerStatesVerified).toBe(true)
    expect(result.collateralAndCashVerifiedFromTransactions).toBe(true)
    expect(result.actorReceipts).toHaveLength(6)
    expect(result.uniqueActorPublisherSamplerReceipts).toBe(8)
    expect(result.actualMatchedFill.size).toBe(100_000n)
    expect(f.reads.every(read => [7n, 9n].includes(read.blockNumber))).toBe(true)
  })

  test('does not accept report-only positions or cash', async () => {
    const f = fixture()
    f.risks[0].positionLots = 0n
    await expect(f.run()).rejects.toThrow('ACTUAL_POSITION_MISMATCH')
    const g = fixture()
    g.actors.trade.accounts[0].cashQ = 0n
    await expect(g.run()).rejects.toThrow('REPORTED_cashQ_MISMATCH')
  })

  test('derives cash from canonical funding and matched fill even if report and state agree on a wrong value', async () => {
    const f = fixture()
    f.risks[0].cashQ += Q
    f.actors.trade.accounts[0].cashQ = f.risks[0].cashQ
    f.snapshot.markets[0].accounts[0].risk!.cashQ = f.risks[0].cashQ
    await expect(f.run()).rejects.toThrow('FILL_CASH_MISMATCH')
    const g = fixture()
    g.actors.trade.collateralAtoms[0] = 11_000_000n
    await expect(g.run()).rejects.toThrow('COLLATERAL_FROM_TRANSACTIONS_MISMATCH')
  })

  test('rejects substituted owner or order calldata and absent actual matching fill', async () => {
    const f = fixture()
    f.transactions.get(hash(106))!.from = LIVE_OWNERS[1]
    await expect(f.run()).rejects.toThrow('ACTOR_SUBSTITUTION')
    const g = fixture()
    g.transactions.get(hash(106))!.input = callData(engineAbi, 'placeOrder', [{ kind: 1, isBuy: true, reduceOnly: false, tick: 501, size: 100_000n, maxFills: 8, expiryBlock: 0 }])
    await expect(g.run()).rejects.toThrow('TRADE_CALLDATA')
    const h = fixture()
    h.receipts.get(hash(106))!.logs = []
    await expect(h.run()).rejects.toThrow('MATCHED_FILL_REQUIRED')
  })

  test('a later sample receipt cannot pass using an earlier capture or invalid observation', async () => {
    const f = fixture()
    f.actors.postTradeSample.observation.t = 1005n
    f.receipts.get(hash(108))!.logs = [f.sampleLog(1005n)]
    await expect(f.run()).rejects.toThrow('SAMPLE_CAPTURE_PRECEDES_TRADE')
    const g = fixture()
    g.receipts.get(hash(108))!.logs = [g.sampleLog(1007n, false)]
    await expect(g.run()).rejects.toThrow('VALID_POST_TRADE_EVENT_REQUIRED')
  })

  test('rejects code changes, unfinalized or reorged checkpoint blocks, and wrong chain', async () => {
    const f = fixture()
    f.client.getCode = async () => '0x600200'
    await expect(f.run()).rejects.toThrow('CODE_CHANGED')
    const g = fixture()
    g.client.getBlock = async args => 'blockNumber' in args ? { ...block(args.blockNumber), hash: hash(999) } : block(100n)
    await expect(g.run()).rejects.toThrow('REORGED')
    const h = fixture()
    h.client.getBlock = async args => block('blockNumber' in args ? args.blockNumber : 6n)
    await expect(h.run()).rejects.toThrow('UNFINALIZED_BLOCK')
    const i = fixture()
    i.client.getChainId = async () => 10143
    await expect(i.run()).rejects.toThrow('WRONG_CHAIN')
  })

  test('rejects duplicate receipts within and across role reports, case independently', async () => {
    const f = fixture()
    f.pricefeed.publisherReceipts = [{ hash: hash(106) }]
    await expect(f.run()).rejects.toThrow('DUPLICATE_RECEIPT')
    expect(() => assertUniqueReceiptSets({ a: [{ hash: hash(255) }], b: [{ transactionHash: hash(255).toUpperCase().replace('0X', '0x') as Hex }] })).toThrow('DUPLICATE_RECEIPT')
  })
})
