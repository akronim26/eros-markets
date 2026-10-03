// Which markets exist and which disputes the treasury funded. The Envio indexer is the normal source; RPC logs
// (100 blocks per call, Monad's public RPC cap) are the fallback when it is down or behind.
import { BondTreasuryAbi, freshProgress, type IndexerClient, KEEPER_MARKETS, MarketRegistryAbi, TREASURY_DISPUTES } from '@eros-oracle/oracle-sdk'
import type { Address, Hex } from 'viem'
import { type DisputeSource, type Logger, type MarketSource, silentLogger } from './types'

export class StaticSource implements MarketSource {
  constructor(private readonly ids: Hex[]) {}
  async marketIds() {
    return [...this.ids]
  }
}

export class IndexerSource implements MarketSource {
  constructor(
    private readonly indexer: IndexerClient,
    private readonly pageSize = 1000,
  ) {}

  async marketIds(): Promise<Hex[]> {
    return (await this.indexer.all<{ id: string }>(KEEPER_MARKETS, 'Market', this.pageSize)).map((m) => m.id.toLowerCase() as Hex)
  }
}

export class IndexerDisputeSource implements DisputeSource {
  constructor(
    private readonly indexer: IndexerClient,
    private readonly pageSize = 1000,
  ) {}

  async assertionIds(): Promise<Hex[]> {
    return (await this.indexer.all<{ id: string }>(TREASURY_DISPUTES, 'Dispute', this.pageSize)).map((d) => d.id.toLowerCase() as Hex)
  }
}

const MARKET_LISTED = MarketRegistryAbi.find((x) => x.type === 'event' && x.name === 'MarketListed')!
const DISPUTE_FUNDED = BondTreasuryAbi.find((x) => x.type === 'event' && x.name === 'DisputeFunded')!

type IdEvent = typeof MARKET_LISTED | typeof DISPUTE_FUNDED

export type LogClient = {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: Address; event: IdEvent; fromBlock: bigint; toBlock: bigint }): Promise<{ args: Record<string, unknown> }[]>
}

/** Collects one indexed bytes32 of an event, `step` blocks per call; each read scans only blocks not yet seen. */
export class LogIdSource {
  private next: bigint
  private readonly ids = new Set<Hex>()

  constructor(
    private readonly client: LogClient,
    private readonly address: Address,
    private readonly event: IdEvent,
    private readonly arg: string,
    fromBlock: bigint,
    private readonly step = 100n,
  ) {
    if (step < 1n) throw new RangeError('step must be at least 1 block')
    this.next = fromBlock
  }

  /** Adds ids known up to `block` (from the indexer); the next read starts after it. */
  advance(ids: Hex[], block: bigint): void {
    for (const id of ids) this.ids.add(id.toLowerCase() as Hex)
    if (block + 1n > this.next) this.next = block + 1n
  }

  async read(): Promise<Hex[]> {
    const head = await this.client.getBlockNumber()
    while (this.next <= head) {
      const to = this.next + this.step - 1n < head ? this.next + this.step - 1n : head
      const logs = await this.client.getLogs({ address: this.address, event: this.event, fromBlock: this.next, toBlock: to })
      for (const l of logs) {
        const v = l.args[this.arg]
        if (typeof v === 'string') this.ids.add(v.toLowerCase() as Hex)
      }
      this.next = to + 1n // only after a successful read, so a failure retries the same range
    }
    return [...this.ids]
  }
}

export class RegistryLogSource implements MarketSource {
  private readonly logs: LogIdSource
  constructor(client: LogClient, registry: Address, fromBlock: bigint, step = 100n) {
    this.logs = new LogIdSource(client, registry, MARKET_LISTED, 'id', fromBlock, step)
  }
  marketIds() {
    return this.logs.read()
  }
  advance(ids: Hex[], block: bigint) {
    this.logs.advance(ids, block)
  }
}

export class TreasuryDisputeSource implements DisputeSource {
  private readonly logs: LogIdSource
  constructor(client: LogClient, treasury: Address, fromBlock: bigint, step = 100n) {
    this.logs = new LogIdSource(client, treasury, DISPUTE_FUNDED, 'assertionId', fromBlock, step)
  }
  assertionIds() {
    return this.logs.read()
  }
  advance(ids: Hex[], block: bigint) {
    this.logs.advance(ids, block)
  }
}

type Scanned = { advance(ids: Hex[], block: bigint): void }

/**
 * The indexer, or the log scan when the indexer is down, erroring or more than `maxLagBlocks` behind. The scan's
 * cursor follows the indexer's progress, so a fallback reads only uncovered blocks. Each switch is logged once.
 */
export class IndexedIds {
  private usingIndexer: boolean | null = null

  constructor(
    private readonly o: {
      name: string
      indexer: IndexerClient
      fromIndexer: () => Promise<Hex[]>
      fromLogs: () => Promise<Hex[]>
      logs: Scanned
      head: () => Promise<bigint>
      maxLagBlocks: bigint
      log?: Logger
    },
  ) {}

  async ids(): Promise<Hex[]> {
    const log = this.o.log ?? silentLogger
    const fresh = await freshProgress(this.o.indexer, await this.o.head(), this.o.maxLagBlocks)
    let reason = fresh.ok ? '' : fresh.reason
    if (fresh.ok) {
      try {
        const ids = await this.o.fromIndexer()
        this.o.logs.advance(ids, BigInt(fresh.progress.progressBlock))
        if (this.usingIndexer !== true) log.info(`${this.o.name}: reading the indexer`, { progressBlock: fresh.progress.progressBlock })
        this.usingIndexer = true
        return ids
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e)
      }
    }
    if (this.usingIndexer !== false) log.warn(`${this.o.name}: indexer not usable, reading RPC logs`, { reason })
    this.usingIndexer = false
    return this.o.fromLogs()
  }
}

export function indexedMarkets(indexer: IndexerClient, logs: RegistryLogSource, head: () => Promise<bigint>, maxLagBlocks: bigint, log?: Logger): MarketSource {
  const src = new IndexerSource(indexer)
  const ids = new IndexedIds({ name: 'markets', indexer, fromIndexer: () => src.marketIds(), fromLogs: () => logs.marketIds(), logs, head, maxLagBlocks, log })
  return { marketIds: () => ids.ids() }
}

export function indexedDisputes(indexer: IndexerClient, logs: TreasuryDisputeSource, head: () => Promise<bigint>, maxLagBlocks: bigint, log?: Logger): DisputeSource {
  const src = new IndexerDisputeSource(indexer)
  const ids = new IndexedIds({ name: 'treasury disputes', indexer, fromIndexer: () => src.assertionIds(), fromLogs: () => logs.assertionIds(), logs, head, maxLagBlocks, log })
  return { assertionIds: () => ids.ids() }
}
