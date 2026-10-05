import { decodeEventLog, keccak256, type Abi, type Address, type Hex } from 'viem'
import { z } from 'zod'
import { publicManifestObject, validatePublicManifest, toPublicManifest, traderAddressSchema } from '../../../packages/oracle-sdk/src/trading-manifest'
import { claimAvailability } from '../../../packages/oracle-sdk/src/trading'

// The signing wrappers retain this stricter local schema. Generic serving is read-only.
export const readManifestSchema = publicManifestObject.extend({ rpcUrl: z.string().url() }).superRefine(validatePublicManifest)
export const manifestSchema = readManifestSchema.refine(value => value.scope === 'local-only' && value.chainId === 31337, 'LOCAL_MANIFEST_ONLY')
export type Manifest = z.infer<typeof readManifestSchema>
export type Block = { number: bigint; hash: Hex; timestamp: bigint }
export type ReadClient = {
  getChainId(): Promise<number>
  getBlock(args: { blockTag?: 'latest'; blockNumber?: bigint }): Promise<Block>
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>
  readContract(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; blockNumber: bigint }): Promise<unknown>
  getLogs(args: { address: Address[]; fromBlock: bigint; toBlock: bigint }): Promise<Array<{
    address: Address; data: Hex; topics: Hex[]; blockNumber: bigint | null; blockHash: Hex | null;
    transactionHash: Hex | null; logIndex: number | null; removed: boolean
  }>>
}
export type Abis = { engine: Abi; vault: Abi; token: Abi; oracle: Abi; registry: Abi; factory?: Abi }

export function assertLocalRpc(rpc: string) {
  const url = new URL(rpc)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('LOCAL_RPC_ONLY')
}

export function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}

export function visibleRisk(raw: unknown): Record<string, unknown> {
  const value = raw as Record<string, unknown>
  return { ...value,
    ...('indexAvailable' in value && !value.indexAvailable ? { indexWad: null } : {}),
    ...('markAvailable' in value && !value.markAvailable ? { markWad: null, markEquityQ: null } : {}),
  }
}

export class LocalReadModel {
  constructor(readonly manifest: Manifest, readonly abis: Abis, private client: ReadClient) {
    if (manifest.scope === 'local-only') assertLocalRpc(manifest.rpcUrl)
    else if (!['http:', 'https:'].includes(new URL(manifest.rpcUrl).protocol)) throw new Error('INVALID_READ_TRANSPORT')
    for (const name of ['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken']) {
      if (!manifest.contracts[name]) throw new Error(`Missing contract: ${name}`)
    }
  }

  private async head() {
    if (await this.client.getChainId() !== this.manifest.chainId) throw new Error(this.manifest.scope === 'local-only' ? 'LOCAL_CHAIN_ONLY' : 'MANIFEST_CHAIN_MISMATCH')
    const block = await this.client.getBlock({ blockTag: 'latest' })
    const identities = [...Object.values(this.manifest.contracts), ...this.manifest.markets.map(market => ({ address: market.engine, codehash: market.codehash }))]
    await Promise.all(identities.map(async identity => {
      const code = await this.client.getCode({ address: identity.address, blockNumber: block.number })
      if (!code || code === '0x' || keccak256(code).toLowerCase() !== identity.codehash.toLowerCase()) throw new Error('DEPLOYMENT_IDENTITY_CHANGED')
    }))
    return block
  }

  private async canonical(block: Block) {
    if ((await this.client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('READ_BLOCK_REORGED')
  }

  publicManifest() { return toPublicManifest(this.manifest) }

  async snapshot(owners?: readonly Address[]) {
    if (owners && (owners.length === 0 || owners.length > 16)) throw new Error('OWNER_LIMIT_16')
    const selected = owners
      ? Object.fromEntries([...new Set(owners.map(owner => traderAddressSchema.parse(owner)))].map(owner => [owner, owner]))
      : this.manifest.accounts
    const block = await this.head()
    const read = (target: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => this.client.readContract({ address: target, abi, functionName, args, blockNumber: block.number })
    const vault = this.manifest.contracts.CollateralVault.address
    const token = this.manifest.contracts.CollateralToken.address
    const markets = await Promise.all(this.manifest.markets.map(async market => {
      const [listingHash, risk, settlement, halt, source, oiAllLots, resolution, core, boundVault, listing] = await Promise.all([
        read(market.engine, this.abis.engine, 'listingHash'), read(market.engine, this.abis.engine, 'marketRiskView'),
        read(market.engine, this.abis.engine, 'getSettlementStatus'), read(market.engine, this.abis.engine, 'getHaltSnapshot'),
        read(market.engine, this.abis.engine, 'sourceState', [market.sourceId]), read(market.engine, this.abis.engine, 'oiAllLots'),
        read(this.manifest.contracts.ResolutionOracle.address, this.abis.oracle, 'getResolution', [market.marketId]),
        read(this.manifest.contracts.MarketRegistry.address, this.abis.registry, 'getMarketCore', [market.marketId]),
        read(market.engine, this.abis.engine, 'collateralVault'),
        read(market.engine, this.abis.engine, 'listing'),
      ])
      if ((listingHash as string).toLowerCase() !== market.listingHash.toLowerCase()
          || (core as { engine: string }).engine.toLowerCase() !== market.engine.toLowerCase()
          || String(boundVault).toLowerCase() !== vault.toLowerCase()) throw new Error('MARKET_BINDING_CHANGED')
      const expected = { marketId: market.marketId, indexSourceId: market.sourceId, token,
        registry: this.manifest.contracts.MarketRegistry.address, resolutionAuthority: this.manifest.contracts.ResolutionOracle.address }
      if (!listing || !Object.entries(expected).every(([key, value]) => String((listing as Record<string, unknown>)[key]).toLowerCase() === value.toLowerCase())) {
        throw new Error('MARKET_BINDING_CHANGED')
      }
      const accounts = await Promise.all(Object.entries(selected).map(async ([name, owner]) => {
        const [trader, freeAtoms, walletAtoms, claimAtoms] = await Promise.all([
          read(market.engine, this.abis.engine, 'participantId', [owner]), read(vault, this.abis.vault, 'freeAtoms', [owner]),
          read(token, this.abis.token, 'balanceOf', [owner]), read(vault, this.abis.vault, 'claimAtoms', [market.engine, owner]),
        ])
        const accountRisk = BigInt(trader as number) === 0n ? null : visibleRisk(await read(market.engine, this.abis.engine, 'accountRiskView', [trader]))
        return { name, owner, trader, freeAtoms, walletAtoms, claimAtoms, risk: accountRisk,
          claimability: claimAvailability(settlement as { claimsEnabled: boolean }, BigInt(claimAtoms as bigint)) }
      }))
      const book = (halt as { halted: boolean }).halted ? { available: false, reason: 'HALTED' }
        : { available: true, bestBidAsk: await read(market.engine, this.abis.engine, 'bestBidAsk') }
      // Older 1x manifests remain readable without calling a selector absent from their bytecode.
      const caps = market.deploymentCapX === undefined ? null : await read(market.engine, this.abis.engine, 'leverageCaps')
      const [reserve, seedQ, slacks, deficit0Q, deficit1Q, recoveryEnabled] = await Promise.all([
        read(market.engine, this.abis.engine, 'reserve'), read(market.engine, this.abis.engine, 'reserveCapBaseQ'),
        read(market.engine, this.abis.engine, 'coverageSlacks'), read(market.engine, this.abis.engine, 'deficitSum0'),
        read(market.engine, this.abis.engine, 'deficitSum1'), read(market.engine, this.abis.engine, 'recoveryEnabled'),
      ])
      return { ...market, risk: visibleRisk(risk), settlement, halt, source, oiAllLots, resolution, book, accounts,
        leverage: { directionalCaps: caps, semantics: 'ceilings only; account margin and reserve checks still apply' },
        reserveCoverage: { reserve, seedQ, slacks, deficit0Q, deficit1Q, recoveryEnabled } }
    }))
    const [recognizedAtoms, custodyAtoms] = await Promise.all([
      read(vault, this.abis.vault, 'recognizedAtoms'), read(token, this.abis.token, 'balanceOf', [vault]),
    ])
    await this.canonical(block)
    return { manifestVersion: 1, scope: this.manifest.scope, chainId: this.manifest.chainId, block, units: { atomsDecimals: 6, qPerAtom: '1000000000000000000', lotsPerClaim: 1000 },
      sourceCommit: this.manifest.sourceCommit, riskScenario: this.manifest.riskScenario,
      sourceMode: this.manifest.sourceMode, provenance: this.publicManifest().provenance, verifiedAt: this.manifest.verifiedAt,
      calibrationEvidence: this.manifest.calibrationEvidence, prices: this.publicManifest().provenance.index === 'external' ? 'independent external source; inspect freshness and availability' : 'controlled fixture, not an external market feed', recognizedAtoms, custodyAtoms, markets }
  }

  async events(fromBlock: bigint) {
    const block = await this.head()
    if (fromBlock < 0n || fromBlock > block.number) throw new Error('EVENT_RANGE_LIMIT_5000_BLOCKS')
    const toBlock = fromBlock + 4999n < block.number ? fromBlock + 4999n : block.number
    const addresses = [...this.manifest.markets.map(market => market.engine), this.manifest.contracts.CollateralVault.address,
      this.manifest.contracts.ResolutionOracle.address, this.manifest.contracts.MarketRegistry.address]
    const records = []
    const seen = new Set<string>()
    const canonicalHashes = new Map<bigint, Hex>()
    const permittedAddresses = new Set(addresses.map(address => address.toLowerCase()))
    for (let cursor = fromBlock; cursor <= toBlock; cursor += 250n) {
      const end = cursor + 249n < toBlock ? cursor + 249n : toBlock
      const logs = await this.client.getLogs({ address: addresses, fromBlock: cursor, toBlock: end })
      for (const log of logs) {
        if (log.removed || log.blockHash === null || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) throw new Error('INCOMPLETE_EVENT_LOG')
        if (log.blockNumber < cursor || log.blockNumber > end || !permittedAddresses.has(log.address.toLowerCase())) throw new Error('EVENT_OUTSIDE_QUERY')
        if (!canonicalHashes.has(log.blockNumber)) canonicalHashes.set(log.blockNumber, (await this.client.getBlock({ blockNumber: log.blockNumber })).hash)
        if (canonicalHashes.get(log.blockNumber) !== log.blockHash) throw new Error('EVENT_BLOCK_REORGED')
        const id = `${this.manifest.chainId}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`
        if (seen.has(id)) continue
        seen.add(id)
        let decoded: unknown = null
        for (const abi of [this.abis.engine, this.abis.vault, this.abis.oracle, this.abis.registry]) {
          try { decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }); break } catch {}
        }
        records.push({ id, ...log, decoded })
        if (records.length > 10000) throw new Error('EVENT_RESULT_LIMIT')
      }
    }
    await this.canonical(block)
    return { block, fromBlock, toBlock, nextFromBlock: toBlock < block.number ? toBlock + 1n : null, records,
      semantics: 'one bounded page of raw activity, not an event-only custody ledger; only Fill represents a trade' }
  }
}
