// Task O37.2: ResolutionOracle events → Market, Resolution (state history), Proposal, PanelResult, Assertion, Dispute,
// TrustSet, Watchdog.
import { indexer, type Market } from 'envio'
import { blankMarket, lc, logId, num, PATH, refresh, STATE, ts } from '../lib'

type Ctx = { Market: { get(id: string): Promise<Market | undefined>; set(m: Market): void }; Assertion: { get(id: string): Promise<any> } }

async function market(context: Ctx, id: string, e: Parameters<typeof blankMarket>[1]): Promise<Market> {
  return (await context.Market.get(lc(id))) ?? blankMarket(lc(id), e)
}
async function save(context: Ctx, m: Market, e: Parameters<typeof blankMarket>[1]) {
  const a = m.assertion_id ? await context.Assertion.get(m.assertion_id) : undefined
  context.Market.set(refresh(m, a, e))
}

indexer.onEvent({ contract: 'ResolutionOracle', event: 'ResolutionInitialized' }, async ({ event, context }) => {
  await save(context, await market(context, event.params.id, event), event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'HaltRecorded' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  await save(context, { ...m, haltedAt: p.haltedAt, oiHaltLots: p.oiHaltLots, voidDeadline: p.voidDeadline, trustSetId: num(p.trustSetId) }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'StateChanged' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const [from, to] = [num(event.params.from), num(event.params.to)]
  context.Resolution.set({
    id: logId(event), market_id: m.id, from, to, fromName: STATE[from] ?? String(from), toName: STATE[to] ?? String(to),
    block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash,
  })
  await save(context, { ...m, state: to }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'ResolutionRequested' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  await save(context, { ...m, requestCount: num(event.params.requestCount) }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'ProposedL1' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  context.Proposal.set({
    id: logId(event), market_id: m.id, outcome: num(p.outcome), path: 1, pathName: PATH[1], evidenceHash: p.evidenceHash, evidenceURI: undefined,
    valueHash: p.valueHash, observedAt: p.observedAt, attempt: m.attempts, proposer: event.transaction.from ?? '',
    block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash,
  })
  await save(context, { ...m, proposedOutcome: num(p.outcome), proposedPath: 1, evidenceHash: p.evidenceHash, evidenceURI: undefined, valueHash: p.valueHash, observedAt: p.observedAt }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'ProposalRecorded' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  const path = num(p.path)
  context.Proposal.set({
    id: logId(event), market_id: m.id, outcome: num(p.outcome), path, pathName: PATH[path] ?? String(path), evidenceHash: p.evidenceHash,
    evidenceURI: p.evidenceURI, valueHash: undefined, observedAt: undefined, attempt: num(p.attempt), proposer: event.transaction.from ?? '',
    block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash,
  })
  await save(context, { ...m, proposedOutcome: num(p.outcome), proposedPath: path, evidenceHash: p.evidenceHash, evidenceURI: p.evidenceURI, valueHash: undefined, observedAt: undefined }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'PanelResultAccepted' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  const routedTo = num(p.routedTo)
  context.PanelResult.set({
    id: logId(event), market_id: m.id, phase: num(p.phase), labels: p.labels.map(num), calibratedBps: p.calibratedBps.map(num),
    evidenceHash: p.evidenceHash, evidenceURI: p.evidenceURI, routedTo, routedToName: STATE[routedTo] ?? String(routedTo),
    block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash,
  })
  await save(context, m, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'PanelNotYet' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  await save(context, { ...m, panelNotYet: m.panelNotYet + 1 }, event)
})

// ADJ-27: an assertion's attempt is `attempts` before assertProposal increments it.
indexer.onEvent({ contract: 'ResolutionOracle', event: 'Asserted' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  const id = lc(p.assertionId)
  const prior = await context.Assertion.get(id) // OOv3's AssertionMade comes first in the same transaction
  const a = {
    id, market_id: m.id, attempt: m.attempts, venue: p.venue, outcome: num(p.outcome), path: num(p.path), bond: p.bond, liveness: p.liveness,
    expiresAt: p.expiresAt, asserter: p.asserter, assertedAt: ts(event), assertedTx: event.transaction.hash,
    oov3Asserter: prior?.oov3Asserter, currency: prior?.currency, identifier: prior?.identifier, domainId: prior?.domainId,
    disputed: prior?.disputed ?? false, disputer: prior?.disputer, disputedAt: prior?.disputedAt, settled: prior?.settled ?? false,
    truthful: prior?.truthful, bondRecipient: prior?.bondRecipient, settledAt: prior?.settledAt, rejected: false, rejectedMask: undefined, retryOpensAt: undefined,
  }
  context.Assertion.set(a)
  context.Market.set(refresh({ ...m, attempts: m.attempts + 1, assertion_id: id }, a, event))
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'Disputed' }, async ({ event, context }) => {
  const id = lc(event.params.assertionId)
  const d = await context.Dispute.get(id)
  context.Dispute.set({
    id, market_id: lc(event.params.id), disputer: d?.disputer, caller: d?.caller, viaTreasury: d?.viaTreasury ?? false, treasuryBond: d?.treasuryBond,
    closed: d?.closed ?? false, syncedByOracle: true, disputedAt: d?.disputedAt ?? ts(event), txHash: d?.txHash ?? event.transaction.hash,
  })
  const a = await context.Assertion.get(id)
  if (a) context.Assertion.set({ ...a, disputed: true, disputedAt: a.disputedAt ?? ts(event) })
  await save(context, await market(context, event.params.id, event), event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'AssertionRejected' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  const p = event.params
  const a = await context.Assertion.get(lc(p.assertionId))
  if (a) context.Assertion.set({ ...a, rejected: true, rejectedMask: num(p.rejectedMask), retryOpensAt: p.retryOpensAt })
  await save(context, { ...m, rejectedMask: num(p.rejectedMask), retryOpensAt: p.retryOpensAt, assertion_id: undefined }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'Finalized' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  await save(context, { ...m, finalOutcome: num(event.params.outcome), finalReason: num(event.params.reason) }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'Voided' }, async ({ event, context }) => {
  const m = await market(context, event.params.id, event)
  await save(context, { ...m, voidReason: num(event.params.reason) }, event)
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'TrustSetCreated' }, async ({ event, context }) => {
  context.TrustSet.set({ id: String(event.params.setId), production: event.params.production, createdAt: ts(event), active: false, activatedAt: undefined, revocations: [] })
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'TrustSetActivated' }, async ({ event, context }) => {
  const id = String(event.params.setId)
  const t = await context.TrustSet.getOrThrow(id)
  // one active set at a time: the previous one is no longer active
  for (const prev of await context.TrustSet.getWhere({ active: { _eq: true } })) if (prev.id !== id) context.TrustSet.set({ ...prev, active: false })
  context.TrustSet.set({ ...t, active: true, activatedAt: ts(event) })
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'TrustSetRevoked' }, async ({ event, context }) => {
  const t = await context.TrustSet.getOrThrow(String(event.params.setId))
  context.TrustSet.set({ ...t, revocations: [...t.revocations, `${num(event.params.what)}:${event.params.detail}`] })
})

indexer.onEvent({ contract: 'ResolutionOracle', event: 'WatchdogHeartbeat' }, async ({ event, context }) => {
  const id = lc(event.params.watchdog)
  const w = await context.Watchdog.get(id)
  context.Watchdog.set({ id, lastHeartbeat: event.params.at, beats: (w?.beats ?? 0) + 1 })
})
