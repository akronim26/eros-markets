import { loadGas } from '@eros-oracle/oracle-sdk'
import { takeSnapshot } from '@eros-oracle/snapshotter'
import { beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { NoteError } from '../src/backend/note'
import { EvidenceStore } from '../src/backend/store'
import { ProposalError } from '../src/sign/bundle'
import { CommitteeConsole, parseChoice } from '../src/ui/console'
import { renderCase } from '../src/ui/render'
import { dueAlerts, serviceAlerts, type ServiceAlert } from '../src/ui/service'
import { FakeChain, loadRecorded, MEMBER_KEYS, RECORDED } from './fake'

const rec = loadRecorded()
const ID = rec.marketId
const NEWS = 'https://news.example.com/report/evt_1'
const [A, B] = MEMBER_KEYS.map((k) => privateKeyToAccount(k))

const pages: Record<string, () => Response> = {
  'https://api.example-sports.com/v1/events/evt_1': () => Response.json({ event: { status: 'FINAL', home: 3, away: 1 } }),
  'https://stats.example-data.org/match/evt_1': () => new Response('<html><body><h1>Full time: Home 3-1 Away</h1></body></html>', { headers: { 'content-type': 'text/html' } }),
  [NEWS]: () => new Response('<html><body><p>Report: the home side won 3-1.</p></body></html>', { headers: { 'content-type': 'text/html' } }),
}
const fetched: string[] = []
const fetchFn = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  fetched.push(url)
  return pages[url]?.() ?? new Response('no', { status: 404 })
}) as typeof fetch

let chain: FakeChain
let store: EvidenceStore
let snapDir: string
const make = (account?: ReturnType<typeof privateKeyToAccount>) =>
  new CommitteeConsole({ chain, store, gas: loadGas(), takeSnapshot: (req) => takeSnapshot(req, { fetchFn, clock: () => 1_791_046_400 }), account, dataDir: mkdtempSync(join(tmpdir(), 'console-')), clock: () => 1_791_046_500 })

beforeEach(() => {
  chain = new FakeChain(ID, rec)
  snapDir = mkdtempSync(join(tmpdir(), 'console-snap-'))
  cpSync(RECORDED, snapDir, { recursive: true })
  store = new EvidenceStore(snapDir)
  fetched.length = 0
})

describe('a reviewer completes a case in the console', () => {
  test('read, add a source, propose with a note, second signature, submit', async () => {
    const a = make(A)
    const b = make(B)
    const panelHash = rec.lastPanelResult.evidenceHash as Hex

    // 1. the case, rules before the panel
    const text = await a.show(ID)
    expect(text.indexOf('RULES (decide from these alone)')).toBeLessThan(text.indexOf('PANEL (reference only)'))
    expect(text).toContain(rec.text.rules)
    expect(text).toContain('Full time: Home 3-1 Away')

    // 2. a source the panel did not have: a fresh snapshot of the panel's sources plus the new page
    const session = await a.snapshot(ID, [NEWS])
    expect(fetched).toEqual(['https://api.example-sports.com/v1/events/evt_1', 'https://stats.example-data.org/match/evt_1', NEWS])
    expect(session.evidenceHash).not.toBe(panelHash)
    expect(session.evidenceURI).toBe(`eros-snapshot:${session.evidenceHash}`)
    expect(keccak256(readFileSync(join(snapDir, `${session.evidenceHash}.json`)))).toBe(session.evidenceHash)
    const c = await a.case(ID)
    expect(c.evidence!.evidenceHash).toBe(session.evidenceHash)
    expect(c.evidence!.items.map((i) => [i.url, i.allowListed])).toEqual([
      ['https://api.example-sports.com/v1/events/evt_1', true],
      ['https://stats.example-data.org/match/evt_1', true],
      [NEWS, false], // not on the market's allow-list: context
    ])
    expect(await a.show(ID)).toContain('Report: the home side won 3-1.')

    // 3. the decision: YES, NO or INVALID only, with a note
    expect(() => parseChoice('NOT_YET')).toThrow(ProposalError)
    await expect(a.propose(ID, 'YES', '  ')).rejects.toThrow(NoteError)
    const { path, bundle } = await a.propose(ID, parseChoice('yes'), 'Home 3-1 at full time (items 0, 1, 2): above 2, so YES.')
    expect(bundle.proposal.outcome).toBe(1)
    expect(bundle.proposal.evidenceHash).toBe(session.evidenceHash)
    expect(bundle.evidenceURI).toBe(session.evidenceURI)
    const note = store.note(bundle.proposal.noteHash)!
    expect(note).toMatchObject({ outcome: 'YES', evidenceHash: session.evidenceHash, addedSources: [NEWS], reviewer: A.address, writtenAt: 1_791_046_500 })
    expect(bundle.signatures.map((s) => s.signer)).toEqual([A.address])

    // 4. the second member decides on their own; a stranger cannot sign
    await expect(b.sign(path, 'NO')).rejects.toThrow(/the proposal is YES; you chose NO/)
    await expect(make(privateKeyToAccount(generatePrivateKey())).sign(path, 'YES')).rejects.toThrow(/not a member/)
    await b.sign(path, 'YES')
    const st = await a.status(path)
    expect(st).toMatchObject({ outcome: 'YES', enough: true, threshold: 2, stale: [] })

    // 5. anyone submits
    await make().submit(path)
    expect(chain.sent.length).toBe(1)
    expect(chain.sent[0].sigs.length).toBe(2)
    expect(chain.sent[0].uri).toBe(session.evidenceURI)
    expect(chain.sent[0].gas).toBe(820_000n)
  })

  test('without the snapshot in the store the reviewer must take one before proposing', async () => {
    store = new EvidenceStore(mkdtempSync(join(tmpdir(), 'empty-')))
    const a = make(A)
    expect(await a.show(ID)).toContain('not in the local store')
    await expect(a.propose(ID, 'YES', 'note')).rejects.toThrow(/take a snapshot first/)
    await a.snapshot(ID, [])
    expect(fetched).toEqual(['https://api.example-sports.com/v1/events/evt_1']) // the Layer 1 endpoint; the panel's pages are unknown
    const { bundle } = await a.propose(ID, 'YES', 'note')
    expect(existsSync(join(store.dir, `${bundle.proposal.evidenceHash}.json`))).toBe(true)
  })

  test('reading needs no key; proposing does', async () => {
    const anon = make()
    expect(await anon.show(ID)).toContain('QUESTION')
    await expect(anon.propose(ID, 'YES', 'note')).rejects.toThrow(/COMMITTEE_PRIVATE_KEY/)
  })
})

describe('service level', () => {
  test('T_r after entering review; the L2 deadline and retryOpensAt minus 2 h', async () => {
    const con = make()
    const since = BigInt(rec.enteredReview)
    const l2 = BigInt(rec.resolution.l2StartedAt) + BigInt(rec.core.l2DeadlineSecs as string)
    chain.res.retryOpensAt = since + 86_400n
    const c = await con.case(ID)
    const expected: Array<[ServiceAlert['kind'], bigint, ServiceAlert['severity']]> = [
      ['REVIEW_SERVICE_LEVEL', since + 7200n, 'alert'],
      ['L2_DEADLINE_SOON', l2 - 7200n, 'page'],
      ['RETRY_OPENS_SOON', since + 86_400n - 7200n, 'page'],
    ]
    expect(serviceAlerts(c).map((a) => [a.kind, a.at, a.severity])).toEqual(
      expected.sort((first, second) => (first[1] < second[1] ? -1 : 1)),
    )
    // nothing due just after entering review except what is already within 2 h of a deadline
    expect(dueAlerts(c, since - 1n).map((a) => a.kind)).toEqual(l2 - 7200n <= since - 1n ? ['L2_DEADLINE_SOON'] : [])
    expect(dueAlerts(c, since + 7200n).map((a) => a.kind)).toContain('REVIEW_SERVICE_LEVEL')
    expect(dueAlerts(c, since + 86_400n - 7200n).map((a) => a.kind)).toContain('RETRY_OPENS_SOON')
    expect(dueAlerts(c, since + 86_400n).map((a) => a.kind)).not.toContain('RETRY_OPENS_SOON') // passed: no longer the committee's alone
  })

  test('the alerts command lists due alerts of markets waiting for the committee only', async () => {
    const con = make()
    chain.t = BigInt(rec.enteredReview) + 7200n
    expect((await con.alerts()).map((a) => a.kind)).toContain('REVIEW_SERVICE_LEVEL')
    chain.res.state = 7 // Proposed
    expect(await con.alerts()).toEqual([])
  })

  test('the rendered case shows due alerts', async () => {
    const con = make()
    const c = await con.case(ID)
    expect(renderCase(c, BigInt(rec.enteredReview) + 7200n)).toContain('! REVIEW_SERVICE_LEVEL (alert)')
  })
})
