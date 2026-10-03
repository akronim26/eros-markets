import type { Assertion, Market } from 'envio'
import { describe, expect, it } from 'vitest'
import { blankMarket, deadlineOf, refresh } from '../src/lib'

const ev = { chainId: 10143, block: { number: 1, timestamp: 1_000 }, logIndex: 0, transaction: { hash: '0x01' } }
const m = (f: Partial<Market>): Market => ({ ...blankMarket('0xaa', ev), tau: 500n, ...f })
const a = (f: Partial<Assertion>) => ({ expiresAt: 2_000n, disputed: false, settled: false, ...f }) as Assertion

describe('deadline and live', () => {
  it('Proposed with a live assertion: its expiry; disputed or settled: voidDeadline', () => {
    expect(deadlineOf(m({ state: 7, voidDeadline: 9_000n }), a({}))).toBe(2_000n)
    expect(deadlineOf(m({ state: 7, voidDeadline: 9_000n }), a({ disputed: true }))).toBe(9_000n)
    expect(deadlineOf(m({ state: 7, voidDeadline: 9_000n }), a({ settled: true }))).toBe(9_000n)
    expect(deadlineOf(m({ state: 7, voidDeadline: 9_000n }), undefined)).toBe(9_000n) // not asserted yet
    expect(deadlineOf(m({ state: 7, voidDeadline: 1_500n }), a({}))).toBe(1_500n) // the sooner one
  })

  it('Review after a rejection: the retry window opening; Open: voidDeadline; before the halt: tau', () => {
    expect(deadlineOf(m({ state: 5, retryOpensAt: 3_000n, voidDeadline: 9_000n }), undefined)).toBe(3_000n)
    expect(deadlineOf(m({ state: 5, voidDeadline: 9_000n }), undefined)).toBe(9_000n)
    expect(deadlineOf(m({ state: 6, retryOpensAt: 3_000n, voidDeadline: 9_000n }), undefined)).toBe(9_000n)
    expect(deadlineOf(m({ state: 0 }), undefined)).toBe(500n)
  })

  it('live exactly in Proposed, Disputed, Review and Open', () => {
    const live = Array.from({ length: 11 }, (_, s) => refresh(m({ state: s }), undefined, ev).live)
    expect(live.flatMap((l, s) => (l ? [s] : []))).toEqual([5, 6, 7, 8])
    expect(refresh(m({ state: 8 }), undefined, ev)).toMatchObject({ stateName: 'Disputed', updatedAt: 1_000n })
  })
})
