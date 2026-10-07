import { describe, expect, test } from 'bun:test'
import { keccak256, type Address, type Hex } from 'viem'
import { assertLocalRpc, json, LocalReadModel, manifestSchema, readManifestSchema, visibleRisk, type Block, type ReadClient } from '../src/read-model'
import { readHandler } from '../src/main'

const address = (suffix: number) => `0x${suffix.toString(16).padStart(40, '0')}` as Address
const hash = (suffix: number) => `0x${suffix.toString(16).padStart(64, '0')}` as Hex
const runtime = '0x600100' as Hex
const block: Block = { number: 44n, hash: hash(44), timestamp: 1800000000n }
const manifest = manifestSchema.parse({ scope: 'local-only', chainId: 31337, sourceCommit: 'test', rpcUrl: 'http://127.0.0.1:18545',
  contracts: Object.fromEntries(['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken'].map((name, index) => [name, { address: address(index + 10), codehash: keccak256(runtime), deployBlock: 1 }])),
  markets: ['demo', 'terminal'].map((name, index) => ({ name, engine: address(index + 1), marketId: hash(index + 1), sourceId: hash(3), listingHash: hash(4), codehash: keccak256(runtime), deployBlock: 2 })),
  accounts: { buyer: address(21), seller: address(22) },
})

function fixture() {
  const reads: Array<{ blockNumber: bigint; functionName: string }> = []
  const client: ReadClient = {
    getChainId: async () => 31337,
    getBlock: async () => block,
    getCode: async () => runtime,
    getLogs: async () => [],
    readContract: async call => {
      reads.push(call)
      switch (call.functionName) {
        case 'listingHash': return hash(4)
        case 'collateralVault': return manifest.contracts.CollateralVault.address
        case 'listing': return { marketId: call.address === address(1) ? hash(1) : hash(2), indexSourceId: hash(3),
          token: manifest.contracts.CollateralToken.address, registry: manifest.contracts.MarketRegistry.address,
          resolutionAuthority: manifest.contracts.ResolutionOracle.address }
        case 'marketRiskView': return { indexAvailable: false, indexWad: 0n, markAvailable: false, markWad: 0n }
        case 'getSettlementStatus': return { claimsEnabled: false }
        case 'getHaltSnapshot': return { halted: call.address === address(2) }
        case 'getMarketCore': return { engine: call.args[0] === hash(1) ? address(1) : address(2) }
        case 'sourceState': return { lastSequence: 5n }
        case 'getResolution': return { state: 0 }
        case 'participantId': return call.args[0] === address(21) ? 1 : 0
        case 'accountRiskView': return { cashQ: 10n ** 24n, positionLots: 100n, markAvailable: false, markEquityQ: 0n }
        case 'bestBidAsk': return [490, 510]
        default: return 1000000n
      }
    },
  }
  return { client, reads, model: new LocalReadModel(manifest, { engine: [], vault: [], token: [], oracle: [], registry: [] }, client) }
}

describe('isolated local read model', () => {
  test('refuses public endpoints, credentials, redirects via query and nonlocal chain manifests', () => {
    for (const value of ['https://127.0.0.1:8545', 'http://example.com:8545', 'http://user:pass@localhost:8545', 'http://localhost:8545/?target=test', 'http://localhost:8545/path']) {
      expect(() => assertLocalRpc(value)).toThrow('LOCAL_RPC_ONLY')
    }
    expect(() => manifestSchema.parse({ ...manifest, chainId: 10143 })).toThrow()
    expect(() => manifestSchema.parse({ ...manifest, scope: 'production' })).toThrow()
    expect(() => manifestSchema.parse({ ...manifest, markets: [manifest.markets[0], manifest.markets[0]] })).toThrow()
  })

  test('all reads use one canonical block and keep missing values distinct from zero', async () => {
    const { model, reads } = fixture()
    const result = await model.snapshot()
    expect(reads.every(read => read.blockNumber === block.number)).toBe(true)
    expect(result.markets[0].risk.indexWad).toBeNull()
    expect(result.markets[0].accounts[1].risk).toBeNull()
    expect(result.markets[1].book).toEqual({ available: false, reason: 'HALTED' })
    expect(result.markets[0].accounts[0].risk?.cashQ).toBe(10n ** 24n)
    expect(json(result)).toContain('1000000000000000000000000')
    expect(result.riskScenario).toBe('fully-backed')
    expect(reads.some(read => read.functionName === 'leverageCaps')).toBe(false)
  })

  test('valid zero probability is not replaced with unknown', () => {
    expect(visibleRisk({ indexAvailable: true, indexWad: 0n }).indexWad).toBe(0n)
  })

  test('stale mark and pending preparation remain unavailable despite a valid zero INDEX and escrow balance', async () => {
    const { client, model } = fixture()
    const original = client.readContract
    client.readContract = async call => {
      if (call.functionName === 'marketRiskView') return { indexAvailable: true, indexWad: 0n, markAvailable: false, markWad: 900000000000000000n, pendingWork: 4, accountingState: 2 }
      if (call.functionName === 'getSettlementStatus') return { claimsEnabled: false, oracleFinalityAccepted: true, accountingComplete: false, snapshotCursor: 1n, payoutCursor: 0n, accountCount: 10n }
      return original(call)
    }
    const result = await model.snapshot([address(21)])
    const market = result.markets[0]
    expect(market.risk.indexWad).toBe(0n)
    expect(market.risk.markWad).toBeNull()
    expect(market.risk.pendingWork).toBe(4)
    expect(market.accounts[0].risk?.markEquityQ).toBeNull()
    expect(market.accounts[0].claimAtoms).toBe(1000000n)
    expect(market.accounts[0].claimability).toEqual({ available: false, reason: 'CLAIMS_DISABLED' })
    expect(market.settlement).toMatchObject({ oracleFinalityAccepted: true, accountingComplete: false, payoutCursor: 0n })
    client.readContract = async call => call.functionName === 'getSettlementStatus' ? { claimsEnabled: true } : original(call)
    expect((await model.snapshot([address(21)])).markets[0].accounts[0].claimability.available).toBe(true)
    client.readContract = async call => call.functionName === 'getSettlementStatus' ? { claimsEnabled: true } : call.functionName === 'claimAtoms' ? 0n : original(call)
    expect((await model.snapshot([address(21)])).markets[0].accounts[0].claimability).toEqual({ available: false, reason: 'NO_CLAIM' })
  })

  test('wrong-network API responses never return a plausible empty snapshot or use account reads', async () => {
    const { client, model, reads } = fixture()
    client.getChainId = async () => 10143
    const response = await readHandler(model, model.abis)(new Request('http://localhost/snapshot'))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'READ_UNAVAILABLE' })
    expect(reads).toHaveLength(0)
  })

  test('supports arbitrary owners without requiring fixture registration or substituting another owner', async () => {
    const { model } = fixture()
    const owner = address(800)
    const result = await model.snapshot([owner, owner])
    expect(result.markets[0].accounts).toHaveLength(1)
    expect(result.markets[0].accounts[0].owner.toLowerCase()).toBe(owner)
    expect(result.markets[0].accounts[0].trader).toBe(0)
    expect(result.markets[0].accounts[0].risk).toBeNull()
    await expect(model.snapshot(Array(17).fill(owner))).rejects.toThrow('OWNER_LIMIT_16')
  })

  test('generic testnet reads require identity/provenance while local signer schema remains restricted', async () => {
    const candidate = { ...manifest, scope: 'testnet-read-only', chainId: 10143, rpcUrl: 'https://rpc.invalid/private-api-key',
      contracts: { ...manifest.contracts, MarketFactory: { address: address(50), codehash: keccak256(runtime), deployBlock: 1 } },
      markets: [{ ...manifest.markets[0], name: 'real_event' }],
      verifiedAt: { blockNumber: '40', blockHash: hash(40) },
      provenance: { collateral: 'testnet', index: 'external', calibration: 'empirical', resolution: 'oracle' } }
    expect(() => manifestSchema.parse(candidate)).toThrow('LOCAL_MANIFEST_ONLY')
    expect(() => readManifestSchema.parse({ ...candidate, verifiedAt: undefined })).toThrow('TESTNET_REQUIRES')
    const { client } = fixture()
    client.getChainId = async () => 10143
    const model = new LocalReadModel(readManifestSchema.parse(candidate), { engine: [], vault: [], token: [], oracle: [], registry: [] }, client)
    const result = await model.snapshot([address(21)])
    expect(result.chainId).toBe(10143)
    expect(result.provenance.index).toBe('external')
    expect(result.markets).toHaveLength(1)
    expect(json(model.publicManifest())).not.toContain('private-api-key')
    expect(json(model.publicManifest())).not.toContain('rpcUrl')
  })

  test('HTTP interface bounds owners, exposes credential-free manifests, and preserves read-only/CORS controls', async () => {
    const { model, client } = fixture()
    const fetch = readHandler(model, { engine: [], vault: [], token: [], oracle: [], registry: [], factory: [] })
    const get = (path: string, init?: RequestInit) => fetch(new Request(`http://localhost${path}`, init))
    expect(await (await get('/manifest')).json()).not.toHaveProperty('rpcUrl')
    const account = await (await get(`/snapshot?owner=${address(800)}`)).json() as any
    expect(account.markets[0].accounts[0].owner.toLowerCase()).toBe(address(800))
    expect((await get('/snapshot?owner=bad')).status).toBe(400)
    expect((await get('/events?fromBlock=-1')).status).toBe(400)
    expect((await get('/snapshot', { method: 'POST' })).status).toBe(405)
    expect((await get('/snapshot', { headers: { Origin: 'https://example.invalid' } })).status).toBe(403)
    for (const origin of ['http://localhost:3100', 'http://127.0.0.1:3100']) {
      const response = await get('/snapshot', { headers: { Origin: origin } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    }
    expect((await get('/abi/factory')).status).toBe(200)
    client.getChainId = async () => { throw new Error('https://rpc.invalid/secret') }
    const failure = await get('/snapshot')
    expect(failure.status).toBe(503)
    expect(await failure.text()).not.toContain('secret')
  })

  test('old deployments remain accessible through bounded history pages', async () => {
    const { client, model } = fixture()
    client.getBlock = async () => ({ ...block, number: 6000n })
    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    client.getLogs = async range => {
      if (range.toBlock - range.fromBlock >= 100n) throw new Error('RPC_BLOCK_RANGE_LIMIT_100')
      ranges.push(range); return []
    }
    const first = await model.events(1n)
    expect(first.toBlock).toBe(5000n)
    expect(first.nextFromBlock).toBe(5001n)
    expect(ranges).toHaveLength(50)
    expect(ranges.every(range => range.toBlock - range.fromBlock < 100n)).toBe(true)
    const second = await model.events(first.nextFromBlock!)
    expect(second.fromBlock).toBe(5001n)
    expect(second.toBlock).toBe(6000n)
    expect(second.nextFromBlock).toBeNull()
  })

  test('rejects wrong chain, changed bytecode, changed registry binding, and reorgs', async () => {
    const wrongChain = fixture()
    wrongChain.client.getChainId = async () => 10143
    await expect(wrongChain.model.snapshot()).rejects.toThrow('LOCAL_CHAIN_ONLY')
    const wrongCode = fixture()
    wrongCode.client.getCode = async () => '0x00'
    await expect(wrongCode.model.snapshot()).rejects.toThrow('DEPLOYMENT_IDENTITY_CHANGED')
    const wrongBinding = fixture()
    const read = wrongBinding.client.readContract
    wrongBinding.client.readContract = async call => call.functionName === 'getMarketCore' ? { engine: address(999) } : read(call)
    await expect(wrongBinding.model.snapshot()).rejects.toThrow('MARKET_BINDING_CHANGED')
    const reorg = fixture()
    reorg.client.getBlock = async args => args.blockNumber ? { ...block, hash: hash(999) } : block
    await expect(reorg.model.snapshot()).rejects.toThrow('READ_BLOCK_REORGED')
  })

  test('bounds log ranges, rejects incomplete or removed logs, and retains stable identifiers', async () => {
    const { client, model } = fixture()
    await expect(model.events(45n)).rejects.toThrow('EVENT_RANGE_LIMIT')
    await expect(model.events(-1n)).rejects.toThrow('EVENT_RANGE_LIMIT')
    const log = { address: address(1), data: '0x' as Hex, topics: [], blockNumber: 44n, blockHash: hash(44), transactionHash: hash(88), logIndex: 0, removed: false }
    client.getLogs = async () => [log, log]
    const result = await model.events(1n)
    expect(result.records[0].id).toBe(`31337:${hash(44)}:${hash(88)}:0`)
    expect(result.records).toHaveLength(1)
    client.getLogs = async () => [{ ...log, removed: true }]
    await expect(model.events(1n)).rejects.toThrow('INCOMPLETE_EVENT_LOG')
    client.getLogs = async () => [{ ...log, blockNumber: 99n }]
    await expect(model.events(1n)).rejects.toThrow('EVENT_OUTSIDE_QUERY')
    client.getLogs = async () => [{ ...log, address: address(999) }]
    await expect(model.events(1n)).rejects.toThrow('EVENT_OUTSIDE_QUERY')
    client.getLogs = async () => [{ ...log, blockHash: hash(9) }]
    await expect(model.events(1n)).rejects.toThrow('EVENT_BLOCK_REORGED')
  })
})
