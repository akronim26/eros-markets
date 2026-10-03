// Task O31.1: where the keeper learns which markets exist (plan §9.1, §9.3). The indexer is the normal source;
// until it runs (O37) the registry's MarketListed logs are read directly, 100 blocks per call because Monad's
// public RPC caps log ranges there (§9.3). A fixed list serves tests and one-off runs.
import { MarketRegistryAbi } from '@eros-oracle/oracle-sdk'
import type { Address, Hex } from 'viem'
import type { MarketSource } from './types'

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

/** The read side of a viem public client that RegistryLogSource needs. */
export type LogClient = {
  getBlockNumber(): Promise<bigint>
  getLogs(args: { address: Address; event: typeof MARKET_LISTED; fromBlock: bigint; toBlock: bigint }): Promise<{ args: { id?: Hex } }[]>
}

/**
 * MarketListed logs of the registry from its deploy block, scanned forward `step` blocks per call. The cursor and
 * the ids seen are kept, so each later call reads only the new blocks.
 */
export class RegistryLogSource implements MarketSource {
  private next: bigint
  private readonly ids = new Set<Hex>()

  constructor(
    private readonly client: LogClient,
    private readonly registry: Address,
    fromBlock: bigint,
    private readonly step = 100n,
  ) {
    if (step < 1n) throw new RangeError('step must be at least 1 block')
    this.next = fromBlock
  }

  async marketIds(): Promise<Hex[]> {
    const head = await this.client.getBlockNumber()
    while (this.next <= head) {
      const to = this.next + this.step - 1n < head ? this.next + this.step - 1n : head
      const logs = await this.client.getLogs({ address: this.registry, event: MARKET_LISTED, fromBlock: this.next, toBlock: to })
      for (const l of logs) if (l.args.id) this.ids.add(l.args.id.toLowerCase() as Hex)
      this.next = to + 1n // advanced only after the range was read: a failed call is retried from the same block
    }
    return [...this.ids]
  }
}
