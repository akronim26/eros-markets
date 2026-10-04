// The example market's FeedSpec: YES when event.home > 2 once event.status is FINAL.
import { describe, expect, test } from 'bun:test'
import { keccak256, stringToBytes } from 'viem'
import { Intake } from '../src/intake'
import { checkL1, evaluateFeed } from '../src/l1'
import { proposalKey, type Signal } from '../src/types'
import { combine } from '../src/verdict'
import { event, FakeChain, ID, L1_URL, l1Proposal, SPEC, tableFetch } from './fake'

const FALLBACK_URL = 'https://backup.example-sports.com/v1/events/evt_1'
const FALLBACK = { ...SPEC, urlTemplate: 'https://backup.example-sports.com/v1/events/{id}' }

describe('the verdict rule', () => {
  const s = (source: Signal['source'], outcome: Signal['outcome']): Signal => ({ source, outcome, detail: '' })
  test.each([
    [[s('L1', 'YES')], 'AGREE'],
    [[s('L1', 'NO')], 'CONTRADICT'],
    [[s('L1', null)], 'UNSURE'],
    [[], 'UNSURE'],
    [[s('L1', 'NO'), s('FALLBACK', null)], 'CONTRADICT'],
    [[s('L1', 'YES'), s('FALLBACK', 'NO')], 'UNSURE'],
    [[s('MODEL', 'INVALID'), s('L1', 'NO')], 'CONTRADICT'], // against YES, though not on the same outcome
    [[s('MODEL', null), s('L1', 'YES')], 'AGREE'],
  ] as const)('%j with YES proposed → %s', (signals, kind) => {
    expect(combine('YES', [...signals]).kind).toBe(kind)
  })
})

describe('intake', () => {
  test('every new proposal once, in log order, from every path; asserted markets tracked', async () => {
    const chain = new FakeChain()
    const intake = new Intake(chain)
    const l1 = l1Proposal(1)
    const reviewed = { ...l1Proposal(2), path: 3, evidenceURI: 'eros-snapshot:0x01', attempt: 1, logIndex: 1 }
    chain.queue = { proposals: [l1, reviewed, l1], asserted: [{ marketId: ID, assertionId: `0x${'aa'.repeat(32)}` }] }
    expect(await intake.next()).toEqual([l1, reviewed])
    chain.queue = { proposals: [l1, { ...reviewed, block: 99n }], asserted: [] }
    expect(await intake.next()).toEqual([]) // same (market, attempt, path, evidence): already seen
    expect(intake.asserted.get(ID.toLowerCase() as never)).toBe(`0x${'aa'.repeat(32)}`)
    expect(proposalKey(l1)).not.toBe(proposalKey({ ...l1, attempt: 1 }))
  })
})

describe('Layer 1 re-run', () => {
  test('the FeedSpec URL from the watchdog’s own fetch, evaluated by the shared evaluator', async () => {
    const { fn, calls } = tableFetch({ [L1_URL]: { body: event(3, 1) } })
    const r = await evaluateFeed(SPEC, { fetchFn: fn })
    expect(r).toEqual({ status: 'YES', code: 'OK', valueLexeme: '3', url: L1_URL })
    expect(calls[0].init?.redirect).toBe('manual')
    expect((calls[0].init?.headers as Record<string, string>).accept).toBe('application/json')
  })

  test('a recorded L1 YES that the feed now contradicts (home 1) is flagged', async () => {
    const chain = new FakeChain()
    const { fn } = tableFetch({ [L1_URL]: { body: event(1, 1) } })
    const v = await checkL1(l1Proposal(1), chain, { fetchFn: fn })
    expect(v.kind).toBe('CONTRADICT')
    expect(v.signals).toEqual([{ source: 'L1', outcome: 'NO', detail: `${L1_URL}: NO OK value 1` }])
    expect(v.reason).toContain('the value now (1) differs from the one reported')
  })

  test('agreement: the recorded outcome and value hold', async () => {
    const { fn } = tableFetch({ [L1_URL]: { body: event(3, 1) } })
    const v = await checkL1(l1Proposal(1, '3'), new FakeChain(), { fetchFn: fn })
    expect(v.kind).toBe('AGREE')
    expect(v.reason).not.toContain('differs')
    expect(keccak256(stringToBytes('3'))).toBe(l1Proposal(1, '3').valueHash!)
  })

  test('no answer from the feed is not a contradiction: not final, HTTP error, network failure, missing credentials', async () => {
    const cases = [
      tableFetch({ [L1_URL]: { body: event(3, 1, 'LIVE') } }).fn,
      tableFetch({ [L1_URL]: { status: 503, body: 'busy' } }).fn,
      tableFetch({ [L1_URL]: () => { throw new TypeError('connection refused') } }).fn,
    ]
    for (const fetchFn of cases) expect((await checkL1(l1Proposal(2), new FakeChain(), { fetchFn })).kind).toBe('UNSURE')
    const chain = new FakeChain()
    chain.spec = { ...SPEC, authRef: `0x${'ab'.repeat(32)}` }
    const { fn, calls } = tableFetch({ [L1_URL]: { body: event(1, 1) } })
    const v = await checkL1(l1Proposal(1), chain, { fetchFn: fn })
    expect(v.kind).toBe('UNSURE')
    expect(v.signals[0].detail).toContain('NO_CREDENTIALS')
    expect(calls).toEqual([]) // nothing fetched without the provider's key
    await checkL1(l1Proposal(1), chain, { fetchFn: fn, auth: () => ({ header: 'x-api-key', value: 'k' }) })
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('k')
  })

  test('a body over the 250 KB cap is an error', async () => {
    const big = JSON.stringify({ event: { status: 'FINAL', home: 1, away: 1, pad: 'x'.repeat(250 * 1024) } })
    const r = await evaluateFeed(SPEC, { fetchFn: tableFetch({ [L1_URL]: { body: big } }).fn })
    expect(r.status).toBe('ERROR')
    expect(r.code).toBe('BODY_TOO_LARGE')
  })

  test('the listed fallback source: both against → contradiction; split → a human', async () => {
    const fallbacks = { [ID.toLowerCase()]: FALLBACK }
    let fetchFn = tableFetch({ [L1_URL]: { body: event(1, 1) }, [FALLBACK_URL]: { body: event(1, 1) } }).fn
    let v = await checkL1(l1Proposal(1), new FakeChain(), { fetchFn, fallbacks })
    expect(v.kind).toBe('CONTRADICT')
    expect(v.signals.map((x) => [x.source, x.outcome])).toEqual([['L1', 'NO'], ['FALLBACK', 'NO']])
    fetchFn = tableFetch({ [L1_URL]: { body: event(3, 1) }, [FALLBACK_URL]: { body: event(1, 1) } }).fn
    v = await checkL1(l1Proposal(1), new FakeChain(), { fetchFn, fallbacks })
    expect(v.kind).toBe('UNSURE')
    // the primary down, the fallback against: still a contradiction
    fetchFn = tableFetch({ [L1_URL]: { status: 500, body: '' }, [FALLBACK_URL]: { body: event(1, 1) } }).fn
    expect((await checkL1(l1Proposal(1), new FakeChain(), { fetchFn, fallbacks })).kind).toBe('CONTRADICT')
  })
})
