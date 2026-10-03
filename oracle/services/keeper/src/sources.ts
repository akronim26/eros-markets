// Task O31.1: where the keeper learns which markets exist (plan §9.1, §9.3), and O31.3 which disputes the treasury
// funded. The Envio indexer (O37) is the normal source; the registry's MarketListed and the treasury's DisputeFunded
// logs, read 100 blocks per call because Monad's public RPC caps log ranges there (§9.3), are the fallback whenever the
// indexer does not answer or is too far behind the chain head. A fixed list serves tests and one-off runs.
import { BondTreasuryAbi, freshProgress, type IndexerClient, KEEPER_MARKETS, MarketRegistryAbi, TREASURY_DISPUTES } from '@eros-oracle/oracle-sdk'
import type { Address, Hex } from 'viem'
import { type DisputeSource, type Logger, type MarketSource, silentLogger } from './types'

export class StaticSource implements MarketSource {
  constructor(private readonly ids: Hex[]) {}
  async marketIds() {
    return [...this.ids]
  }
}

/** Envio HyperIndex (§9.3): every `Market` entity's id, a page at a time. */
export class IndexerSource implements MarketSource {
  constructor(
    private readonly indexer: IndexerClient,
    private readonly pageSize = 1000,
  ) {}

  async marketIds(): Promise<Hex[]> {
    return (await this.indexer.all<{ id: string }>(KEEPER_MARKETS, 'Market', this.pageSize)).map((m) => m.id.toLowerCase() as Hex)
  }
}

/** Envio HyperIndex: every assertion the treasury disputed with the watchdog float (`Dispute.viaTreasury`). */
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

/** The read side of a viem public client that the log sources need. */
export type LogClient = {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: Address; event: IdEvent; fromBlock: bigint; toBlock: bigint }): Promise<{ args: Record<string, unknown> }[]>
}

/**
 * One indexed bytes32 of an event, collected from `fromBlock`, scanned forward `step` blocks per call (Monad's
 * public RPC caps log ranges at 100 blocks, §9.3). The cursor and the ids seen are kept, so each later call reads
 * only the new blocks.
 */
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

  /** Takes ids already known up to `block` (from the indexer): a later read() starts after it. */
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
      this.next = to + 1n // advanced only after the range was read: a failed call is retried from the same block
    }
    return [...this.ids]
  }
}

/** MarketListed logs of the registry from its deploy block. */
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

/** DisputeFunded logs of BondTreasury from its deploy block: every assertion the treasury disputed (O31.3). */
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

/** A list of ids the indexer serves and a log scan can rebuild (RegistryLogSource, TreasuryDisputeSource). */
type Scanned = { advance(ids: Hex[], block: bigint): void }

/**
 * The indexer first, the log scan when it is not usable: down, erroring, or more than `maxLagBlocks` behind the chain
 * head. While the indexer is used, the log scan's cursor follows its progress, so a fallback reads only the blocks
 * the indexer had not covered. Switches are logged once each way.
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

/** Markets from the indexer, with the registry's logs as the fallback. */
export function indexedMarkets(indexer: IndexerClient, logs: RegistryLogSource, head: () => Promise<bigint>, maxLagBlocks: bigint, log?: Logger): MarketSource {
  const src = new IndexerSource(indexer)
  const ids = new IndexedIds({ name: 'markets', indexer, fromIndexer: () => src.marketIds(), fromLogs: () => logs.marketIds(), logs, head, maxLagBlocks, log })
  return { marketIds: () => ids.ids() }
}

/** Treasury disputes from the indexer, with the treasury's logs as the fallback. */
export function indexedDisputes(indexer: IndexerClient, logs: TreasuryDisputeSource, head: () => Promise<bigint>, maxLagBlocks: bigint, log?: Logger): DisputeSource {
  const src = new IndexerDisputeSource(indexer)
  const ids = new IndexedIds({ name: 'treasury disputes', indexer, fromIndexer: () => src.assertionIds(), fromLogs: () => logs.assertionIds(), logs, head, maxLagBlocks, log })
  return { assertionIds: () => ids.ids() }
}
