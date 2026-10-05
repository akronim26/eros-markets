import { keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem'

export type EnginePin = { tag: string; marketId: Hex; engine: Address; codehash: Hex; listingHash: Hex; deployBlock: bigint }
export type EngineConfig = { kind: 'stub' } | { kind: 'book-risk'; chainId: number; markets: EnginePin[]; claimsTimeoutMs: number }
export type Settlement = {
  finalOutcome: number; claimsEnabled: boolean; oracleFinalityAccepted: boolean; recoveryRequired?: boolean
  [key: string]: unknown
}
export type EngineReader = {
  getChainId(): Promise<number>
  getCode(args: { address: Address }): Promise<Hex | undefined>
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>
}

const monitorAbi = parseAbi(['function requestReduceOnly(bytes32 reason)', 'function setMonitorRestricted(bool restricted)', 'function listingHash() view returns (bytes32)'])
const isHex = (value: unknown, bytes: number): value is Hex => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)

/** Real-engine mode only enrolls explicitly pinned, already listed markets. It never reuses the short stub listing defaults. */
export function parseEngineConfig(raw: unknown): EngineConfig {
  const value = raw as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid E2E engine config')
  if (value.kind === 'stub' && Object.keys(value).length === 1) return { kind: 'stub' }
  if (value.kind !== 'book-risk' || !Number.isSafeInteger(value.chainId) || ![31337, 10143].includes(value.chainId as number)
      || !Array.isArray(value.markets) || value.markets.length === 0) throw new Error('Real E2E config requires chain and pinned prelisted markets')
  const claimsTimeoutMs = value.claimsTimeoutMs ?? 7_200_000
  if (!Number.isSafeInteger(claimsTimeoutMs) || (claimsTimeoutMs as number) <= 0 || (claimsTimeoutMs as number) > 86_400_000) throw new Error('Invalid claims timeout')
  const markets = value.markets.map((entry: unknown): EnginePin => {
    const market = entry as Record<string, unknown> | null
    if (!market || typeof market.tag !== 'string' || !/^[a-z0-9-]+$/.test(market.tag) || !isHex(market.marketId, 32)
        || !isHex(market.engine, 20) || !isHex(market.codehash, 32) || !isHex(market.listingHash, 32)
        || typeof market.deployBlock !== 'string' || !/^(0|[1-9][0-9]*)$/.test(market.deployBlock)) throw new Error('Invalid E2E market pin')
    return { tag: market.tag, marketId: market.marketId, engine: market.engine, codehash: market.codehash,
      listingHash: market.listingHash, deployBlock: BigInt(market.deployBlock) }
  })
  for (const field of ['tag', 'marketId', 'engine'] as const) {
    if (new Set(markets.map(market => market[field].toLowerCase())).size !== markets.length) throw new Error(`Duplicate E2E ${field}`)
  }
  return { kind: 'book-risk', chainId: value.chainId as number, markets, claimsTimeoutMs: claimsTimeoutMs as number }
}

export class EngineAdapter {
  constructor(readonly config: EngineConfig, private readonly client: EngineReader, private readonly settlementAbi: Abi) {}

  pinForTag(tag: string): EnginePin {
    if (this.config.kind !== 'book-risk') throw new Error('Only real-engine mode uses pinned markets')
    const pin = this.config.markets.find(market => market.tag === tag)
    if (!pin) throw new Error(`Prelist and pin the real ${tag} market; short-horizon stub listing is disabled`)
    return pin
  }

  async verify(engine: Address): Promise<void> {
    if (this.config.kind !== 'book-risk') return
    if (await this.client.getChainId() !== this.config.chainId) throw new Error('E2E engine chain mismatch')
    const pin = this.config.markets.find(market => market.engine.toLowerCase() === engine.toLowerCase())
    if (!pin) throw new Error('E2E engine is not enrolled')
    const [code, listingHash] = await Promise.all([
      this.client.getCode({ address: engine }),
      this.client.readContract({ address: engine, abi: monitorAbi, functionName: 'listingHash' }),
    ])
    if (!code || keccak256(code).toLowerCase() !== pin.codehash.toLowerCase()
        || String(listingHash).toLowerCase() !== pin.listingHash.toLowerCase()) throw new Error('E2E engine identity mismatch')
  }

  async restriction(engine: Address, reason: Hex) {
    await this.verify(engine)
    return this.config.kind === 'book-risk'
      ? { abi: monitorAbi, functionName: 'requestReduceOnly', args: [reason] as readonly unknown[] }
      : { abi: monitorAbi, functionName: 'setMonitorRestricted', args: [true] as readonly unknown[] }
  }

  async settlement(engine: Address): Promise<Settlement> {
    await this.verify(engine)
    return await this.client.readContract({ address: engine, abi: this.settlementAbi, functionName: 'getSettlementStatus' }) as Settlement
  }

  /** The existing keeper owns bounded preparation. Oracle Final alone is not a real-engine payout. */
  async waitForClaims(engine: Address, timing = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }): Promise<Settlement> {
    const deadline = timing.now() + (this.config.kind === 'book-risk' ? this.config.claimsTimeoutMs : 0)
    for (;;) {
      const state = await this.settlement(engine)
      if (state.recoveryRequired) throw new Error('E2E engine requires recovery; claims remain disabled')
      if (state.claimsEnabled || this.config.kind === 'stub') return state
      if (timing.now() >= deadline) throw new Error('E2E keeper did not complete bounded settlement preparation before timeout')
      await timing.sleep(Math.min(1000, deadline - timing.now()))
    }
  }
}
