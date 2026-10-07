// Queries against the Envio indexer's GraphQL API (oracle/indexer), used because Monad's public RPC caps log reads
// at 100 blocks. The indexer's tests validate every query against its schema.
//
// `_meta.progressBlock` is the last block whose events are fully written; readers that need every event read no
// further, and fall back to RPC logs when the indexer is down or behind.

export const MARKET_FIELDS = `
  id state stateName live deadline tau hasFeed engine attempts proposedOutcome proposedPath evidenceHash evidenceURI
  valueHash observedAt haltedAt voidDeadline rejectedMask retryOpensAt finalOutcome finalReason voidReason updatedAt
  assertion { id expiresAt bond liveness disputed settled asserter }`

/** Markets in Proposed, Disputed, Review or Open, soonest deadline first. */
export const LIVE_MARKETS = `query LiveMarkets($limit: Int = 100) {
  Market(where: { live: { _eq: true } }, order_by: [{ deadline: asc }, { id: asc }], limit: $limit) {${MARKET_FIELDS}
  }
}`

/** One market with its state history, proposals, panel results, assertions and disputes. */
export const MARKET_DETAIL = `query MarketDetail($id: String!) {
  Market_by_pk(id: $id) {${MARKET_FIELDS}
    rulesHash specHash gateHash listedAt listedTx oiHaltLots trustSetId requestCount panelNotYet
    resolutions(order_by: [{ block: asc }, { id: asc }]) { fromName toName block timestamp txHash }
    proposals(order_by: [{ block: asc }, { logIndex: asc }]) { outcome path pathName evidenceHash evidenceURI valueHash observedAt attempt proposer timestamp txHash }
    panelResults(order_by: [{ block: asc }]) { phase labels calibratedBps evidenceHash evidenceURI routedTo routedToName timestamp txHash }
    assertions(order_by: [{ attempt: asc }]) { ...AssertionFields }
    disputes { id disputer caller viaTreasury treasuryBond closed syncedByOracle disputedAt txHash }
  }
}
fragment AssertionFields on Assertion {
  id attempt venue outcome path bond liveness expiresAt asserter assertedAt assertedTx disputed disputer disputedAt
  settled truthful settledAt rejected rejectedMask retryOpensAt
}`

/** A market's assertions, oldest attempt first. */
export const ASSERTION_HISTORY = `query AssertionHistory($market: String!) {
  Assertion(where: { market_id: { _eq: $market } }, order_by: [{ attempt: asc }]) {
    id attempt venue outcome path bond liveness expiresAt asserter assertedAt assertedTx disputed disputer disputedAt
    settled truthful settledAt rejected rejectedMask retryOpensAt
  }
}`

/** Every listed market's id, paged. */
export const KEEPER_MARKETS = `query KeeperMarkets($limit: Int!, $offset: Int!) {
  Market(order_by: [{ id: asc }], limit: $limit, offset: $offset) { id }
}`

/** Every assertion the treasury disputed, paged. */
export const TREASURY_DISPUTES = `query TreasuryDisputes($limit: Int!, $offset: Int!) {
  Dispute(where: { viaTreasury: { _eq: true } }, order_by: [{ id: asc }], limit: $limit, offset: $offset) { id }
}`

/** Non-final markets past their deadline, oldest first. */
export const KEEPER_DUE = `query KeeperDue($now: numeric!, $limit: Int = 200) {
  Market(where: { state: { _neq: 10 }, deadline: { _lte: $now } }, order_by: [{ deadline: asc }], limit: $limit) {${MARKET_FIELDS}
  }
}`

/** Unsettled assertions by expiry. */
export const OPEN_ASSERTIONS = `query OpenAssertions($limit: Int = 200) {
  Assertion(where: { settled: { _eq: false }, rejected: { _eq: false } }, order_by: [{ expiresAt: asc }], limit: $limit) {
    id expiresAt bond disputed market { id state }
  }
}`

/** Widest block range per paginated watchdog intake; every page must be exhausted. */
export const WATCHDOG_RANGE_BLOCKS = 10_000n

/** Proposals and assertions in blocks (from, to], in chain order. */

export const WATCHDOG_EVENTS = `query WatchdogEvents($from: Int!, $to: Int!, $limit: Int!, $proposalOffset: Int!, $assertionOffset: Int!) {
  Proposal(where: { block: { _gt: $from, _lte: $to } }, order_by: [{ block: asc }, { logIndex: asc }, { id: asc }], limit: $limit, offset: $proposalOffset) {
    market_id outcome path evidenceHash evidenceURI valueHash observedAt attempt block logIndex
  }
  Assertion(where: { assertedBlock: { _gt: $from, _lte: $to } }, order_by: [{ assertedBlock: asc }, { assertedLogIndex: asc }, { id: asc }], limit: $limit, offset: $assertionOffset) {
    id market_id assertedBlock assertedLogIndex
  }
}`

/** CRE reports the oracle refused. */
export const FAILED_REPORTS = `query FailedReports {
  ReportAttempt(where: { result: { _eq: false } }, order_by: [{ block: desc }]) { forwarder workflowExecutionId reportId relayer block txHash }
}`

/** The indexer's progress on one chain. */
export const INDEXER_PROGRESS = `query IndexerProgress($chainId: Int!) {
  _meta(where: { chainId: { _eq: $chainId } }) { chainId progressBlock sourceBlock isReady }
}`

export const INDEXER_QUERIES = {
  LIVE_MARKETS, MARKET_DETAIL, ASSERTION_HISTORY, KEEPER_MARKETS, TREASURY_DISPUTES, KEEPER_DUE, OPEN_ASSERTIONS, WATCHDOG_EVENTS, FAILED_REPORTS, INDEXER_PROGRESS,
}

export class IndexerError extends Error {}

/** Throws IndexerError on a network or HTTP error, GraphQL errors, or a response without data. */
export async function gql<T>(url: string, query: string, variables: Record<string, unknown> = {}, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<T> {
  let res: Response
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    // These errors are logged by keepers/watchdogs. Provider URLs commonly embed
    // credentials in the path or query, and transport errors may echo that URL.
    throw new IndexerError('indexer: request failed or timed out')
  }
  if (!res.ok) throw new IndexerError(`indexer: HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (body?.errors?.length) throw new IndexerError('indexer: GraphQL request rejected')
  if (!body?.data) throw new IndexerError('indexer: no data in the response')
  return body.data
}

export type IndexerProgress = { chainId: number; progressBlock: number; sourceBlock: number; isReady: boolean }

export class IndexerClient {
  constructor(
    readonly url: string,
    readonly chainId: number,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return gql<T>(this.url, query, variables, this.fetchFn)
  }

  /** Throws when the indexer does not index this chain. */
  async progress(): Promise<IndexerProgress> {
    const { _meta } = await this.query<{ _meta: IndexerProgress[] }>(INDEXER_PROGRESS, { chainId: this.chainId })
    const m = _meta?.[0]
    if (!m || m.chainId !== this.chainId || !Number.isSafeInteger(m.progressBlock) || m.progressBlock < 0
      || !Number.isSafeInteger(m.sourceBlock) || m.sourceBlock < m.progressBlock) throw new IndexerError(`indexer: no progress for chain ${this.chainId}`)
    return m
  }

  /** Bounded complete scan. Short pages can be server caps; only an empty page completes the list. */
  async all<T>(query: string, field: string, pageSize = 1000): Promise<T[]> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new IndexerError('indexer: invalid page size')
    const rows: T[] = []
    let previous: string | undefined
    for (let offset = 0, pages = 0; pages < 1000; pages++) {
      const data = await this.query<Record<string, T[]>>(query, { limit: pageSize, offset })
      const page = data[field]
      if (!Array.isArray(page)) throw new IndexerError(`indexer: no ${field} list in the response`)
      if (page.length === 0) return rows
      const signature = JSON.stringify(page)
      if (signature === previous) throw new IndexerError('indexer: repeated page; complete scan unavailable')
      if (rows.length + page.length > 100_000) throw new IndexerError('indexer: row limit; complete scan unavailable')
      previous = signature
      rows.push(...page)
      offset += page.length
    }
    // Never return a partial list that would advance a keeper's RPC cursor.
    throw new IndexerError('indexer: page limit; complete scan unavailable')
  }
}

/** The indexer's progress if it answers and trails `head` by at most `maxLagBlocks`, else the reason it does not. */
export async function freshProgress(c: IndexerClient, head: bigint, maxLagBlocks: bigint): Promise<{ ok: true; progress: IndexerProgress } | { ok: false; reason: string }> {
  try {
    const p = await c.progress()
    if (p.isReady !== true) return { ok: false, reason: 'indexer is not ready' }
    const lag = head - BigInt(p.progressBlock)
    return lag > maxLagBlocks ? { ok: false, reason: `indexer is ${lag} blocks behind the chain head ${head}` } : { ok: true, progress: p }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
