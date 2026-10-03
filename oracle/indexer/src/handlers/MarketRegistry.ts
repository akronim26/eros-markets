// MarketRegistry → Market (listing fields) and Category.
import { indexer } from 'envio'
import { blankMarket, lc, num, refresh, ts } from '../lib'

indexer.onEvent({ contract: 'MarketRegistry', event: 'MarketListed' }, async ({ event, context }) => {
  const p = event.params
  const id = lc(p.id)
  const m = (await context.Market.get(id)) ?? blankMarket(id, event)
  const a = m.assertion_id ? await context.Assertion.get(m.assertion_id) : undefined
  context.Market.set(refresh({
    ...m, engine: p.engine, tau: p.tau, hasFeed: p.hasFeed, groupId: p.groupId, rulesHash: p.rulesHash, specHash: p.specHash, gateHash: p.gateHash,
    listedAt: ts(event), listedTx: event.transaction.hash,
  }, a, event))
})

indexer.onEvent({ contract: 'MarketRegistry', event: 'CategorySet' }, async ({ event, context }) => {
  const p = event.params
  context.Category.set({ id: lc(p.categoryId), gateHash: p.gateHash, u95Bps: num(p.u95Bps), sampleN: p.sampleN, validated: p.validated, updatedAt: ts(event) })
})
