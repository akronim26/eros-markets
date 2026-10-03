// Task O31.1: where the keeper learns which markets exist (plan §9.1, §9.3). The indexer is the normal source;
// until it runs (O37) the registry's MarketListed logs are read directly, 100 blocks per call because Monad's
// public RPC caps log ranges there (§9.3). A fixed list serves tests and one-off runs. O31.3: the treasury's
// DisputeFunded logs, read the same way, list the disputes the keeper closes.
import { BondTreasuryAbi, MarketRegistryAbi } from '@eros-oracle/oracle-sdk'
import type { Address, Hex } from 'viem'
import type { DisputeSource, MarketSource } from './types'

export class StaticSource implements MarketSource {
  constructor(private readonly ids: Hex[]) {}
  async marketIds() {
    return [...this.ids]
  }
}

/**
 * Envio HyperIndex GraphQL (§9.3): every `Market` entity's id, paged by id. The entity name and its `id` field are
 * the plan's; O37 defines the schema and this query is checked against it there.
 */
export class IndexerSource implements MarketSource {
  constructor(
    private readonly url: string,
    private readonly pageSize = 1000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async marketIds(): Promise<Hex[]> {
    const ids: Hex[] = []
    for (let offset = 0; ; offset += this.pageSize) {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query ($limit: Int!, $offset: Int!) { Market(order_by: {id: asc}, limit: $limit, offset: $offset) { id } }',
          variables: { limit: this.pageSize, offset },
        }),
      })
      if (!res.ok) throw new Error(`indexer ${this.url}: HTTP ${res.status}`)
      const body = (await res.json()) as { data?: { Market?: { id: string }[] }; errors?: { message: string }[] }
      if (body.errors?.length) throw new Error(`indexer ${this.url}: ${body.errors.map((e) => e.message).join('; ')}`)
      const page = body.data?.Market
      if (!Array.isArray(page)) throw new Error(`indexer ${this.url}: no Market list in the response`)
      ids.push(...page.map((m) => m.id as Hex))
      if (page.length < this.pageSize) return ids
    }
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
}
