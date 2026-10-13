// BondTreasury → TreasuryLedger (one row per movement) and the treasury side of Dispute.
import { indexer, type TreasuryLedger } from 'envio'
import { lc, logId, num, ts } from '../lib'

type Ev = Parameters<typeof logId>[0]
const row = (event: Ev, kind: string, amount: bigint, f: Partial<TreasuryLedger> = {}): TreasuryLedger => ({
  id: logId(event), kind, ledger: undefined, market_id: undefined, attempt: undefined, account: undefined, assertionId: undefined, amount,
  block: event.block.number, timestamp: ts(event), txHash: event.transaction.hash, ...f,
})

indexer.onEvent({ contract: 'BondTreasury', event: 'Deposited' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'Deposited', event.params.amount, { ledger: num(event.params.ledger), account: event.params.from }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'Withdrawn' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'Withdrawn', event.params.amount, { ledger: num(event.params.ledger), account: event.params.to }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'ListingCommitted' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'ListingCommitted', event.params.amount, { ledger: 0, market_id: lc(event.params.id) }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'ListingReleased' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'ListingReleased', event.params.amount, { ledger: 0, market_id: lc(event.params.id) }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'AssertionFunded' }, async ({ event, context }) => {
  const p = event.params
  context.TreasuryLedger.set(row(event, 'AssertionFunded', p.bond, { ledger: 0, market_id: lc(p.id), attempt: num(p.attempt), account: p.venue }))
})
for (const kind of ['BondReturned', 'BondLost', 'BondStuck'] as const) {
  indexer.onEvent({ contract: 'BondTreasury', event: kind }, async ({ event, context }) => {
    const p = event.params
    context.TreasuryLedger.set(row(event, kind, p.amount, { ledger: 0, market_id: lc(p.id), attempt: num(p.attempt) }))
  })
}
indexer.onEvent({ contract: 'BondTreasury', event: 'DisputeFunded' }, async ({ event, context }) => {
  const p = event.params
  const id = lc(p.assertionId)
  context.TreasuryLedger.set(row(event, 'DisputeFunded', p.bond, { ledger: 1, market_id: lc(p.id), assertionId: id }))
  const d = await context.Dispute.get(id)
  context.Dispute.set({
    id, market_id: lc(p.id), disputer: d?.disputer, caller: d?.caller, viaTreasury: true, treasuryBond: p.bond, closed: d?.closed ?? false,
    syncedByOracle: d?.syncedByOracle ?? false, disputedAt: d?.disputedAt ?? ts(event), txHash: d?.txHash ?? event.transaction.hash,
  })
})
indexer.onEvent({ contract: 'BondTreasury', event: 'DisputeClosed' }, async ({ event, context }) => {
  const id = lc(event.params.assertionId)
  context.TreasuryLedger.set(row(event, 'DisputeClosed', 0n, { ledger: 1, assertionId: id }))
  const d = await context.Dispute.get(id)
  if (d) context.Dispute.set({ ...d, closed: true })
})
indexer.onEvent({ contract: 'BondTreasury', event: 'RewardOwed' }, async ({ event, context }) => {
  const p = event.params
  context.TreasuryLedger.set(row(event, 'RewardOwed', p.amount, { ledger: 2, market_id: lc(p.id), account: p.proposer }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'RewardPaid' }, async ({ event, context }) => {
  const p = event.params
  context.TreasuryLedger.set(row(event, 'RewardPaid', p.amount, { ledger: 2, market_id: lc(p.id), account: p.proposer }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'OwedClaimed' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'OwedClaimed', event.params.amount, { ledger: 2, account: event.params.proposer }))
})
indexer.onEvent({ contract: 'BondTreasury', event: 'Skimmed' }, async ({ event, context }) => {
  context.TreasuryLedger.set(row(event, 'Skimmed', event.params.amount))
})
