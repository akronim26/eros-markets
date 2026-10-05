// In-memory WatchdogChain and the example market's fixtures (listings/example/pack.json).
import type { FeedSpec } from '@eros-oracle/feedspec'
import { readFileSync } from 'node:fs'
import { type Address, type Hex, keccak256, stringToBytes } from 'viem'
import type { AssertionStatus, MarketText, Proposal, ResolutionView, WatchdogChain } from '../src/types'

const pack = JSON.parse(readFileSync(new URL('../../../listings/example/pack.json', import.meta.url), 'utf8'))
export const ID = pack.marketInput.marketId as Hex
export const SPEC: FeedSpec = { ...pack.marketInput.feed }
export const MARKET: MarketText = { question: pack.marketInput.question, rules: pack.marketInput.rules, tau: 1_791_046_043n, hasFeed: true }
export const L1_URL = 'https://api.example-sports.com/v1/events/evt_1'
export const ZERO = `0x${'00'.repeat(32)}` as Hex
export const VENUE = '0x00000000000000000000000000000000000000e0' as Address
export const ME = '0x000000000000000000000000000000000000da7c' as Address

export const event = (home: number, away: number, status = 'FINAL') => JSON.stringify({ event: { status, home, away } })

/** Answers from a URL → (status, body) table and records each request. */
export function tableFetch(table: Record<string, { status?: number; body: string } | (() => never)>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const t = table[url]
    if (!t) return new Response('no route', { status: 404 })
    if (typeof t === 'function') return t()
    return new Response(t.body, { status: t.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fn, calls }
}

export const l1Proposal = (outcome: 1 | 2, lexeme = '3'): Proposal => ({
  marketId: ID,
  outcome,
  path: 1,
  evidenceHash: keccak256(stringToBytes(`report-${outcome}-${lexeme}`)),
  valueHash: keccak256(stringToBytes(lexeme)),
  observedAt: 1_791_046_103n,
  attempt: 0,
  block: 10n,
  logIndex: 0,
})

export class FakeChain implements WatchdogChain {
  address = ME
  t = 1_791_046_200n
  queue: { proposals: Proposal[]; asserted: { marketId: Hex; assertionId: Hex }[] } = { proposals: [], asserted: [] }
  res = new Map<string, ResolutionView>()
  status = new Map<string, AssertionStatus>()
  spec: FeedSpec = SPEC
  text: MarketText = MARKET
  watchdog: Address = ME
  float = 1_000_000_000n
  disputes = { open: 0, max: 20 }
  last = 0n
  simulateError: string | null = null
  disputed: { id: Hex; gas: bigint }[] = []
  beats: bigint[] = []

  /** Unasserted when `assertionId` is omitted. */
  propose(p: Proposal, assertionId?: Hex, st: Partial<AssertionStatus> = {}) {
    this.res.set(p.marketId.toLowerCase(), {
      state: 7, proposed: p.outcome, path: p.path, attempts: assertionId ? p.attempt + 1 : p.attempt,
      assertionId: assertionId ?? ZERO, assertionVenue: VENUE, bond: 11_120_000n, evidenceHash: p.evidenceHash,
    })
    if (assertionId) this.status.set(assertionId, { exists: true, settled: false, disputed: false, expiresAt: this.t + 3600n, bond: 11_120_000n, ...st })
  }

  async now() {
    return this.t
  }
  async events() {
    const q = this.queue
    this.queue = { proposals: [], asserted: [] }
    return q
  }
  async resolution(id: Hex) {
    const r = this.res.get(id.toLowerCase())
    if (!r) throw new Error(`unknown market ${id}`)
    return { ...r }
  }
  async market() {
    return this.text
  }
  async feedSpec() {
    return this.spec
  }
  async allowList() {
    return ['api.example-sports.com', 'stats.example-data.org']
  }
  async assertion(_venue: Address, assertionId: Hex) {
    return this.status.get(assertionId) ?? { exists: false, settled: false, disputed: false, expiresAt: 0n, bond: 0n }
  }
  async watchdogOf() {
    return this.watchdog
  }
  async floatBalance() {
    return this.float
  }
  async openDisputes() {
    return this.disputes
  }
  async lastHeartbeat() {
    return this.last
  }
  async simulateDispute() {
    if (this.simulateError) throw new Error(this.simulateError)
  }
  async dispute(id: Hex, gas: bigint) {
    this.disputed.push({ id, gas })
    const r = this.res.get(id.toLowerCase())!
    const st = this.status.get(r.assertionId)!
    st.disputed = true
    return `0x${'d1'.repeat(32)}` as Hex
  }
  async heartbeat(gas: bigint) {
    this.beats.push(gas)
    this.last = this.t
    return `0x${'be'.repeat(32)}` as Hex
  }
}
