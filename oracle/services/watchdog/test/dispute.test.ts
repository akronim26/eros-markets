import { loadGas } from '@eros-oracle/oracle-sdk'
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { actOnContradiction, DISPUTE_MARGIN_SECS } from '../src/dispute'
import { beat, FloatWatch, floatStatus, HEARTBEAT_EVERY_SECS } from '../src/heartbeat'
import type { Page, Verdict } from '../src/types'
import { Watchdog } from '../src/watchdog'
import { event, FakeChain, ID, L1_URL, l1Proposal, tableFetch } from './fake'

const gas = loadGas()
const A1 = `0x${'a1'.repeat(32)}` as Hex
const contradiction: Verdict = { kind: 'CONTRADICT', signals: [{ source: 'L1', outcome: 'NO', detail: 'home 1' }], reason: 'L1 NO against the proposed YES' }
const pager = () => {
  const pages: Parameters<Page>[0][] = []
  return { page: (e: Parameters<Page>[0]) => void pages.push(e), pages }
}

describe('acting on a contradiction', () => {
  test('a live assertion is disputed with the float, with gas.json’s limit, and a human is paged', async () => {
    const chain = new FakeChain()
    const p = l1Proposal(1)
    chain.propose(p, A1)
    const { page, pages } = pager()
    const r = await actOnContradiction(p, contradiction, chain, gas, page)
    expect(r.action).toBe('DISPUTED')
    expect(chain.disputed).toEqual([{ id: ID, gas: 640_000n }])
    expect(pages.map((x) => x.kind)).toEqual(['DISPUTED'])
  })

  test('not asserted yet: wait for the keeper to assert it', async () => {
    const chain = new FakeChain()
    const p = l1Proposal(1)
    chain.propose(p)
    expect(await actOnContradiction(p, contradiction, chain, gas, pager().page)).toEqual({ action: 'WAIT', reason: 'not asserted yet' })
  })

  test('page only: too late, no float, limit reached, not this market’s watchdog, already disputed, superseded, a revert', async () => {
    const cases: [string, (c: FakeChain) => void][] = [
      ['too late', (c) => (c.t = c.status.get(A1)!.expiresAt - DISPUTE_MARGIN_SECS)],
      ['below the bond', (c) => (c.float = 11_119_999n)],
      ['open-dispute limit', (c) => (c.disputes = { open: 20, max: 20 })],
      ['not the market’s watchdog', (c) => (c.watchdog = '0x0000000000000000000000000000000000000000')],
      ['already disputed', (c) => (c.status.get(A1)!.disputed = true)],
      ['settled', (c) => (c.status.get(A1)!.settled = true)],
      ['another proposal', (c) => (c.res.get(ID.toLowerCase())!.proposed = 2)],
      ['no longer Proposed', (c) => (c.res.get(ID.toLowerCase())!.state = 10)],
      ['would revert', (c) => (c.simulateError = 'NoLiveAssertion()')],
    ]
    for (const [reason, set] of cases) {
      const chain = new FakeChain()
      const p = l1Proposal(1)
      chain.propose(p, A1)
      set(chain)
      const { page, pages } = pager()
      const r = await actOnContradiction(p, contradiction, chain, gas, page)
      expect(r.action).toBe('PAGED')
      expect((r as { reason: string }).reason).toContain(reason)
      expect(chain.disputed).toEqual([])
      expect(pages.map((x) => x.kind)).toEqual(['CONTRADICTION'])
    }
  })

  test('one second before the margin is still in time', async () => {
    const chain = new FakeChain()
    const p = l1Proposal(1)
    chain.propose(p, A1)
    chain.t = chain.status.get(A1)!.expiresAt - DISPUTE_MARGIN_SECS - 1n
    expect((await actOnContradiction(p, contradiction, chain, gas, pager().page)).action).toBe('DISPUTED')
  })
})

describe('heartbeat and float', () => {
  test('a heartbeat when none was sent, then every 10 minutes, with gas.json’s limit', async () => {
    const chain = new FakeChain()
    expect(await beat(chain, gas)).not.toBeNull()
    expect(chain.beats).toEqual([70_000n])
    chain.t += HEARTBEAT_EVERY_SECS - 1n
    expect(await beat(chain, gas)).toBeNull()
    chain.t += 1n
    expect(await beat(chain, gas)).not.toBeNull()
    expect(chain.beats.length).toBe(2)
  })

  test('the float against the live bonds: disputed, settled and expired assertions do not count', async () => {
    const chain = new FakeChain()
    const ids = ['01', '02', '03', '04'].map((x) => `0x${x.repeat(32)}` as Hex)
    const asserted = new Map<Hex, Hex>()
    ids.forEach((id, i) => {
      const a = `0x${String(i + 1).repeat(64)}` as Hex
      chain.propose({ ...l1Proposal(1), marketId: id }, a, [{}, { disputed: true }, { settled: true }, { expiresAt: chain.t }][i])
      asserted.set(id, a)
    })
    chain.float = 11_120_000n
    let s = await floatStatus(chain, asserted)
    expect(s.live.map((x) => x.marketId)).toEqual([ids[0]])
    expect(s.liveBonds).toBe(11_120_000n)
    expect(s.short).toBe(false)
    chain.float = 11_119_999n
    s = await floatStatus(chain, asserted)
    expect(s.short).toBe(true)
    const { page, pages } = pager()
    const w = new FloatWatch(page)
    await w.check(s)
    await w.check(s)
    expect(pages.map((x) => x.kind)).toEqual(['FLOAT_SHORT']) // once per shortfall, not every tick
  })
})

describe('the loop', () => {
  test('an L1 proposal is checked at once and disputed as soon as it is asserted', async () => {
    const chain = new FakeChain()
    const { page, pages } = pager()
    const feed = tableFetch({ [L1_URL]: { body: event(1, 1) } })
    const w = new Watchdog({ chain, gas, page, l1: { fetchFn: feed.fn }, model: { loadSnapshot: async () => null } })
    const p = l1Proposal(1)
    chain.propose(p)
    chain.queue.proposals.push(p)
    let t = await w.tick()
    expect(t.heartbeat).not.toBeNull()
    expect(t.checked[0].result).toEqual({ action: 'WAIT', reason: 'not asserted yet' })
    chain.propose(p, A1)
    chain.queue.asserted.push({ marketId: ID, assertionId: A1 })
    t = await w.tick()
    expect(t.checked[0].result!.action).toBe('DISPUTED')
    expect(chain.disputed.length).toBe(1)
    expect(feed.calls.length).toBe(1) // checked once, when recorded; the verdict is kept while waiting
    t = await w.tick()
    expect(t.checked).toEqual([]) // done with it
    expect(pages.map((x) => x.kind)).toEqual(['DISPUTED'])
  })

  test('agreement ends quietly; an unsure check pages; a failed check is retried', async () => {
    const chain = new FakeChain()
    const { page, pages } = pager()
    let body = event(3, 1)
    let down = true
    const fetchFn = (async () => {
      if (down) throw new TypeError('down')
      return new Response(body)
    }) as unknown as typeof fetch
    const w = new Watchdog({ chain, gas, page, l1: { fetchFn }, model: { loadSnapshot: async () => null } })
    const p = l1Proposal(1)
    chain.propose(p)
    chain.queue.proposals.push(p)
    expect((await w.tick()).checked[0].verdict.kind).toBe('UNSURE') // the feed is down: a human looks
    expect(pages.map((x) => x.kind)).toEqual(['UNSURE'])
    down = false
    const q = { ...l1Proposal(1), attempt: 1 }
    chain.propose(q)
    chain.queue.proposals.push(q)
    expect((await w.tick()).checked[0].verdict.kind).toBe('AGREE')
    expect(pages.length).toBe(1)
    body = event(1, 1)
    chain.res.clear() // reading the market fails: the check is kept and retried
    const r = { ...l1Proposal(1), attempt: 2 }
    chain.queue.proposals.push(r)
    chain.propose({ ...r, marketId: `0x${'77'.repeat(32)}` })
    const t1 = await w.tick()
    expect(t1.checked.length).toBe(0)
    chain.propose(r)
    expect((await w.tick()).checked[0].result).toEqual({ action: 'WAIT', reason: 'not asserted yet' })
  })
})
