// Task O37.3: the queries Disputes Live, the keepers and the watchdog read from the indexer (plan §9.3, §9.5), as GraphQL
// for the Hasura endpoint Envio serves (`envio dev`/`envio start`: http://localhost:8080/v1/graphql). Entity tables are
// named after schema.graphql's types, `<Type>_by_pk` reads one row, derived fields are relationships. Question and
// rules text are not events: pages read them from MarketRegistry.getMarketText.

export const MARKET_FIELDS = `
  id state stateName live deadline tau hasFeed engine attempts proposedOutcome proposedPath evidenceHash evidenceURI
  valueHash observedAt haltedAt voidDeadline rejectedMask retryOpensAt finalOutcome finalReason voidReason updatedAt
  assertion { id expiresAt bond liveness disputed settled asserter }`

/** Disputes Live: every market in Proposed, Disputed, Review or Open, soonest deadline first. */
export const LIVE_MARKETS = `query LiveMarkets($limit: Int = 100) {
  Market(where: { live: { _eq: true } }, order_by: [{ deadline: asc }, { id: asc }], limit: $limit) {${MARKET_FIELDS}
  }
}`

/** Disputes Live detail: the market, its state history, proposals, panel results, assertions and disputes. */
export const MARKET_DETAIL = `query MarketDetail($id: String!) {
  Market_by_pk(id: $id) {${MARKET_FIELDS}
    rulesHash specHash gateHash listedAt listedTx oiHaltLots trustSetId requestCount panelNotYet
    resolutions(order_by: [{ block: asc }, { id: asc }]) { fromName toName block timestamp txHash }
    proposals(order_by: [{ block: asc }, { id: asc }]) { outcome path pathName evidenceHash evidenceURI valueHash observedAt attempt proposer timestamp txHash }
    panelResults(order_by: [{ block: asc }]) { phase labels calibratedBps evidenceHash evidenceURI routedTo routedToName timestamp txHash }
    assertions(order_by: [{ attempt: asc }]) { ...AssertionFields }
    disputes { id disputer caller viaTreasury treasuryBond closed syncedByOracle disputedAt txHash }
  }
}
fragment AssertionFields on Assertion {
  id attempt venue outcome path bond liveness expiresAt asserter assertedAt assertedTx disputed disputer disputedAt
  settled truthful settledAt rejected rejectedMask retryOpensAt
}`

/** A market's assertion history (every attempt, oldest first). */
export const ASSERTION_HISTORY = `query AssertionHistory($market: String!) {
  Assertion(where: { market_id: { _eq: $market } }, order_by: [{ attempt: asc }]) {
    id attempt venue outcome path bond liveness expiresAt asserter assertedAt assertedTx disputed disputer disputedAt
    settled truthful settledAt rejected rejectedMask retryOpensAt
  }
}`

/** Keepers: markets not Final whose current deadline has passed, oldest first (each job re-reads the chain first). */
export const KEEPER_DUE = `query KeeperDue($now: numeric!, $limit: Int = 200) {
  Market(where: { state: { _neq: 10 }, deadline: { _lte: $now } }, order_by: [{ deadline: asc }], limit: $limit) {${MARKET_FIELDS}
  }
}`

/** Keepers: live, undisputed assertions by expiry (finalize when due; the treasury needs B for the next ones). */
export const OPEN_ASSERTIONS = `query OpenAssertions($limit: Int = 200) {
  Assertion(where: { settled: { _eq: false }, rejected: { _eq: false } }, order_by: [{ expiresAt: asc }], limit: $limit) {
    id expiresAt bond disputed market { id state }
  }
}`

/** Watchdog intake: every proposal after a block, in chain order. */
export const PROPOSALS_SINCE = `query ProposalsSince($block: Int!, $limit: Int = 500) {
  Proposal(where: { block: { _gt: $block } }, order_by: [{ block: asc }, { id: asc }], limit: $limit) {
    id market { id } outcome path evidenceHash evidenceURI valueHash observedAt attempt block txHash
  }
}`

/** Refused CRE reports to the oracle (a misconfiguration or a forged report). */
export const FAILED_REPORTS = `query FailedReports {
  ReportAttempt(where: { result: { _eq: false } }, order_by: [{ block: desc }]) { forwarder workflowExecutionId reportId relayer block txHash }
}`

export const QUERIES = { LIVE_MARKETS, MARKET_DETAIL, ASSERTION_HISTORY, KEEPER_DUE, OPEN_ASSERTIONS, PROPOSALS_SINCE, FAILED_REPORTS }

export class IndexerError extends Error {}

/** One query to the indexer's GraphQL endpoint; GraphQL errors throw. */
export async function gql<T>(url: string, query: string, variables: Record<string, unknown> = {}, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw new IndexerError(`indexer HTTP ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new IndexerError(body.errors.map((e) => e.message).join('; '))
  return body.data as T
}
