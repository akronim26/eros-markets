// UmaAdapter and OOv3 → Assertion and Dispute. OOv3 is shared on production chains, so only assertions whose
// callbackRecipient is this deployment's UmaAdapter are kept.
import { type Assertion, indexer } from 'envio'
import { OWN } from '../addresses'
import { lc, ts } from '../lib'

const blank = (id: string): Assertion => ({
  id, market_id: '', attempt: 0, venue: '', outcome: 0, path: 0, bond: 0n, liveness: 0n, expiresAt: 0n, asserter: '', assertedAt: 0n, assertedTx: '', assertedBlock: 0, assertedLogIndex: 0,
  oov3Asserter: undefined, currency: undefined, identifier: undefined, domainId: undefined, disputed: false, disputer: undefined, disputedAt: undefined,
  settled: false, truthful: undefined, bondRecipient: undefined, settledAt: undefined, rejected: false, rejectedMask: undefined, retryOpensAt: undefined,
})

indexer.onEvent({ contract: 'OptimisticOracleV3', event: 'AssertionMade' }, async ({ event, context }) => {
  const p = event.params
  if (lc(p.callbackRecipient) !== lc(OWN[event.chainId]?.adapter ?? '')) return
  const id = lc(p.assertionId)
  const a = (await context.Assertion.get(id)) ?? blank(id)
  context.Assertion.set({ ...a, oov3Asserter: p.asserter, currency: p.currency, identifier: p.identifier, domainId: p.domainId, expiresAt: a.expiresAt || p.expirationTime, bond: a.bond || p.bond })
})

indexer.onEvent({ contract: 'OptimisticOracleV3', event: 'AssertionDisputed' }, async ({ event, context }) => {
  const id = lc(event.params.assertionId)
  const a = await context.Assertion.get(id)
  if (!a) return
  context.Assertion.set({ ...a, disputed: true, disputer: event.params.disputer, disputedAt: ts(event) })
  const d = await context.Dispute.get(id)
  context.Dispute.set({
    id, market_id: a.market_id || undefined, disputer: event.params.disputer, caller: event.params.caller, viaTreasury: d?.viaTreasury ?? false,
    treasuryBond: d?.treasuryBond, closed: d?.closed ?? false, syncedByOracle: d?.syncedByOracle ?? false, disputedAt: ts(event), txHash: event.transaction.hash,
  })
})

indexer.onEvent({ contract: 'OptimisticOracleV3', event: 'AssertionSettled' }, async ({ event, context }) => {
  const a = await context.Assertion.get(lc(event.params.assertionId))
  if (!a) return
  context.Assertion.set({ ...a, settled: true, truthful: event.params.settlementResolution, bondRecipient: event.params.bondRecipient, settledAt: ts(event) })
})

indexer.onEvent({ contract: 'UmaAdapter', event: 'VenueAsserted' }, async ({ event, context }) => {
  const id = lc(event.params.assertionId)
  const a = (await context.Assertion.get(id)) ?? blank(id)
  context.Assertion.set({ ...a, market_id: a.market_id || lc(event.params.marketId), liveness: a.liveness || event.params.liveness, bond: a.bond || event.params.bond })
})

indexer.onEvent({ contract: 'UmaAdapter', event: 'VenueDisputed' }, async ({ event, context }) => {
  const a = await context.Assertion.get(lc(event.params.assertionId))
  if (a) context.Assertion.set({ ...a, disputed: true, disputedAt: a.disputedAt ?? ts(event) })
})

indexer.onEvent({ contract: 'UmaAdapter', event: 'VenueResolved' }, async ({ event, context }) => {
  const a = await context.Assertion.get(lc(event.params.assertionId))
  if (a) context.Assertion.set({ ...a, settled: true, truthful: event.params.truthful, settledAt: a.settledAt ?? ts(event) })
})
