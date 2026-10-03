// Cases from a recorded Review state. Expected values come from the listing pack, the recorded result and hand
// arithmetic, not from the code under test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, keccak256, stringToBytes } from 'viem'
import { buildCase, T_R_SECS } from '../src/backend/case'
import { makeNote, NoteError, noteHash } from '../src/backend/note'
import { EvidenceMismatch, EvidenceStore, hashFromURI } from '../src/backend/store'
import { RState } from '../src/backend/types'
import { FakeChain, loadRecorded, RECORDED } from './fake'

const rec = loadRecorded()
const ID = rec.marketId
const pack = JSON.parse(readFileSync(new URL('../../../listings/example/pack.json', import.meta.url).pathname, 'utf8'))
const panelHash = rec.lastPanelResult.evidenceHash as Hex

let chain: FakeChain
let dir: string
let store: EvidenceStore

beforeEach(() => {
  chain = new FakeChain(ID, rec)
  dir = mkdtempSync(join(tmpdir(), 'case-'))
  cpSync(RECORDED, dir, { recursive: true })
  store = new EvidenceStore(dir)
})
afterEach(() => {})

describe('buildCase from the recorded Review state', () => {
  test('question, rules, outcomes, committee and deadlines', async () => {
    const c = await buildCase(ID, chain, store)
    expect(c.state).toBe('Review')
    expect(c.reviewable).toBe(true)
    expect(c.early).toBe(false)
    expect(c.question).toBe(pack.marketInput.question)
    expect(c.rules).toBe(pack.marketInput.rules)
    expect(c.allowed).toEqual(['YES', 'NO', 'INVALID'])
    expect(c.attempt).toBe(0)
    expect(c.trustSetId).toBe(Number(rec.resolution.trustSetId))
    expect(c.committee.threshold).toBe(2)
    expect(c.committee.members.length).toBe(3)
    const since = BigInt(rec.enteredReview)
    expect(c.deadlines.reviewSince).toBe(since)
    expect(c.deadlines.serviceLevelAt).toBe(since + 7200n)
    expect(T_R_SECS).toBe(7200n)
    expect(c.deadlines.l2DeadlineAt).toBe(BigInt(rec.resolution.l2StartedAt) + BigInt(rec.core.l2DeadlineSecs as string))
    expect(c.deadlines.voidDeadline).toBe(BigInt(rec.resolution.voidDeadline))
    expect(c.deadlines.retryOpensAt).toBeNull()
    expect(c.deadlines.earlyExpiresAt).toBeNull()
  })

  test('the panel: signed labels and ĉ, the run record’s rationales, the candidate', async () => {
    const c = await buildCase(ID, chain, store)
    const p = c.panel!
    expect(p.labels).toEqual(['YES', 'YES', 'YES'])
    expect(p.calibratedBps).toEqual([4900, 4900, 4900])
    expect(p.chat).toEqual([0.49, 0.49, 0.49])
    expect(p.routedTo).toBe('Review')
    expect(p.flags).toBe(0)
    expect(p.injectionSuspected).toBe(false)
    const record = JSON.parse(readFileSync(join(RECORDED, `${panelHash}.panel.json`), 'utf8'))
    expect(p.models!.map((m) => m.rationale)).toEqual(record.outcomes.map((o: any) => o.rationale))
    expect(p.models!.map((m) => m.model)).toEqual(record.outcomes.map((o: any) => o.model))
    // n = 3 independent models, s_i = +1, ĉ_i = 0.49: log-odds = 3 · ln(0.49 / 0.51)
    expect(p.candidate.nEff).toBe(3)
    expect(p.candidate.logOdds).toBeCloseTo(3 * Math.log(49 / 51), 12)
    expect(p.candidate.probabilityYes).toBeCloseTo(1 / (1 + (51 / 49) ** 3), 12)
  })

  test('the evidence: the panel’s snapshot, checked against its hash, items rendered as text', async () => {
    const c = await buildCase(ID, chain, store)
    const e = c.evidence!
    expect(e.evidenceHash).toBe(panelHash)
    expect(hashFromURI(e.evidenceURI)).toBe(panelHash)
    expect(e.available).toBe(true)
    expect(e.items.map((i) => [i.url, i.allowListed])).toEqual([
      ['https://api.example-sports.com/v1/events/evt_1', true],
      ['https://stats.example-data.org/match/evt_1', true],
    ])
    expect(e.items[0].text).toBe('{"event":{"status":"FINAL","home":3,"away":1}}')
    expect(e.items[1].text).toContain('Full time: Home 3-1 Away')
    expect(e.items[1].text).not.toContain('<h1>')
  })

  test('a snapshot missing from the store is shown as unavailable; a tampered one is refused', async () => {
    const c = await buildCase(ID, chain, new EvidenceStore(mkdtempSync(join(tmpdir(), 'empty-'))))
    expect(c.evidence!.available).toBe(false)
    expect(c.evidence!.items).toEqual([])
    expect(c.panel!.models).toBeNull() // no run record either
    expect(c.panel!.flags).toBeNull()
    expect(c.panel!.injectionSuspected).toBeNull()
    const f = join(dir, `${panelHash}.json`)
    const original = readFileSync(f, 'utf8')
    const tampered = original.replace(/"takenAt":(\d+)/, (_m, t) => `"takenAt":${Number(t) + 1}`)
    expect(tampered).not.toBe(original)
    writeFileSync(f, tampered)
    await expect(buildCase(ID, chain, store)).rejects.toThrow(EvidenceMismatch)
  })

  test('rejected outcomes are not offered; a retry window is a deadline', async () => {
    chain.res.rejectedMask = 1 << 1 // the venue rejected YES
    chain.res.retryOpensAt = chain.t + 86_400n
    const c = await buildCase(ID, chain, store)
    expect(c.allowed).toEqual(['NO', 'INVALID'])
    expect(c.deadlines.retryOpensAt).toBe(chain.t + 86_400n)
    chain.res.rejectedMask = (1 << 1) | (1 << 2) | (1 << 3)
    expect((await buildCase(ID, chain, store)).allowed).toEqual([])
  })

  test('EarlyReview: the active trust set, open only before T and within the early TTL', async () => {
    chain.res.state = RState.EarlyReview
    chain.res.earlyStartedAt = chain.t - 60n
    chain.active = 7
    chain.committees.set(7, { members: [], threshold: 2, revoked: [] })
    chain.entered.set(RState.EarlyReview, chain.t - 30n)
    chain.coreView.tau = chain.t + 86_400n
    let c = await buildCase(ID, chain, store)
    expect(c.early).toBe(true)
    expect(c.trustSetId).toBe(7)
    expect(c.reviewable).toBe(true)
    expect(c.deadlines.earlyExpiresAt).toBe(chain.t - 60n + chain.coreView.earlyTtlSecs)
    expect(c.deadlines.reviewSince).toBe(chain.t - 30n)
    chain.t = chain.t - 60n + chain.coreView.earlyTtlSecs // TTL over
    c = await buildCase(ID, chain, store)
    expect(c.reviewable).toBe(false)
  })

  test('a market that is not waiting for the committee is not reviewable', async () => {
    for (const st of [RState.L2Pending, RState.Proposed, RState.Disputed, RState.Final]) {
      chain.res.state = st
      expect((await buildCase(ID, chain, store)).reviewable).toBe(false)
    }
    chain.res.state = RState.Open
    expect((await buildCase(ID, chain, store)).reviewable).toBe(true)
  })

  test('a reviewer’s own snapshot replaces the panel’s', async () => {
    const other = `0x${'11'.repeat(32)}` as Hex
    const c = await buildCase(ID, chain, store, { evidenceHash: other, evidenceURI: `eros-snapshot:${other}` })
    expect(c.evidence!.evidenceHash).toBe(other)
    expect(c.evidence!.available).toBe(false)
  })
})

describe('notes', () => {
  const base = {
    marketId: ID,
    outcome: 'YES' as const,
    evidenceHash: panelHash,
    addedSources: ['https://news.example.com/report/evt_1'],
    reviewer: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955' as const,
    text: '  Final 3-1.  ',
    writtenAt: 1_800_000_000,
  }

  test('noteHash = keccak256 of the JCS bytes (keys sorted, no whitespace), and the store keeps those bytes', () => {
    const n = makeNote(base)
    const jcs =
      `{"addedSources":["https://news.example.com/report/evt_1"],"evidenceHash":"${panelHash}","marketId":"${ID.toLowerCase()}",` +
      `"outcome":"YES","reviewer":"0x14dC79964da2C08b23698B3D3cc7Ca32193d9955","text":"Final 3-1.","version":1,"writtenAt":1800000000}`
    expect(noteHash(n)).toBe(keccak256(stringToBytes(jcs)))
    const h = store.putNote(n)
    expect(h).toBe(keccak256(stringToBytes(jcs)))
    expect(readFileSync(join(dir, 'notes', `${h}.json`), 'utf8')).toBe(jcs)
    expect(store.note(h)).toEqual(n)
  })

  test('refused: no text, too long, an outcome that is not YES/NO/INVALID', () => {
    expect(() => makeNote({ ...base, text: '   ' })).toThrow(NoteError)
    expect(() => makeNote({ ...base, text: 'x'.repeat(4001) })).toThrow(NoteError)
    expect(() => makeNote({ ...base, outcome: 'NOT_YET' as never })).toThrow(NoteError)
  })
})
