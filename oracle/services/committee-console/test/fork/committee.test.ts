// Task O34.2 acceptance on a local deploy (the keeper's O31.4 stack; a public testnet deploy is not authorized, so the
// testnet steps stay for O34.4 after X04). The trust set's committee is anvil's keys #6-#8 (threshold 2), its attestor
// the panel harness's. The real panel runner takes the market to Review (or EarlyReview); then the console, over
// viemCaseChain, does what two reviewers do: read the case, add a source (a new snapshot), propose with a note, sign as a
// second member, submit. Checked on the oracle: the 2-of-3 proposal is accepted (Proposed, path REVIEWED, the
// reviewer's snapshot as evidence); one signature is refused by the contract as well as by the console.
// RECORD=1 also writes test/fixtures/recorded-review (the market state the unit tests build cases from).
import { loadGas, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { takeSnapshot } from '@eros-oracle/snapshotter'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hex, parseEventLogs } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deployStack, fund, resolution, revertTo, snapshot, type Stack } from '../../../keeper/test/fork/stack'
import { ATTESTOR, type Evidence, listPinned, makeRunner, runPanel, startEvidence, toEarlyCheck, toL2Pending } from '../../../panel-runner/test/fork/harness'
import { viemCaseChain } from '../../src/backend/chain'
import { EvidenceStore } from '../../src/backend/store'
import { RState } from '../../src/backend/types'
import { ProposalError } from '../../src/sign/bundle'
import { collect } from '../../src/sign/collect'
import { CommitteeConsole } from '../../src/ui/console'
import { MEMBER_KEYS, RECORDED } from '../fake'

const DEPLOY_MS = 600_000
const SCENARIO_MS = 300_000
const NEWS = 'https://news.example.com/report/evt_1'
const members = MEMBER_KEYS.map((k) => privateKeyToAccount(k))

let s: Stack
let base: Hex
let ev: Evidence

beforeAll(async () => {
  ev = startEvidence()
  s = await deployStack(20_000 + ((process.pid + 13) % 20_000), { attestor: ATTESTOR, committee: members.map((m) => m.address) })
  base = await snapshot(s)
}, DEPLOY_MS)

afterAll(async () => {
  await s?.stop()
  ev?.stop()
})

beforeEach(async () => {
  await revertTo(s, base)
  base = await snapshot(s)
  ev.injected = false
})

async function consoles(snapshotDir: string) {
  const relayer = generatePrivateKey()
  await fund(s, privateKeyToAccount(relayer).address)
  const chain = viemCaseChain({ rpcUrl: s.rpcUrl, deployments: s.deployments, relayerKey: relayer, fromBlock: 0n })
  const store = new EvidenceStore(snapshotDir)
  const make = (i: number) =>
    new CommitteeConsole({ chain, store, gas: loadGas(), takeSnapshot: (req) => takeSnapshot(req, { fetchFn: ev.fetch }), account: members[i], dataDir: mkdtempSync(join(tmpdir(), `committee-${i}-`)) })
  return { chain, a: make(0), b: make(1) }
}

/** The market state the unit tests load (FakeChain): every CaseChain read, and the panel's snapshot and record. */
async function record(chain: ReturnType<typeof viemCaseChain>, id: Hex, snapshotDir: string) {
  const r = await chain.resolution(id)
  const panel = (await chain.lastPanelResult(id))!
  const str = (o: object) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  rmSync(RECORDED, { recursive: true, force: true })
  mkdirSync(RECORDED, { recursive: true })
  const out = {
    chainId: chain.chainId,
    oracle: chain.oracle,
    marketId: id,
    now: String(await chain.now()),
    resolution: str(r),
    core: str(await chain.core(id)),
    text: await chain.text(id),
    allowList: await chain.allowList(id),
    l1Url: (await chain.l1Url(id)) ?? null,
    activeTrustSetId: await chain.activeTrustSetId(),
    committee: await chain.committee(r.trustSetId),
    lastPanelResult: str(panel),
    enteredReview: String(await chain.enteredAt(id, RState.Review)),
  }
  writeFileSync(join(RECORDED, 'chain.json'), JSON.stringify(out, null, 2) + '\n')
  for (const f of [`${panel.evidenceHash}.json`, `${panel.evidenceHash}.panel.json`]) copyFileSync(join(snapshotDir, f), join(RECORDED, f))
}

describe('committee console on a local deploy', () => {
  test('Review: a 2-of-3 proposal with an added source is accepted by the oracle', async () => {
    const id = await listPinned(s)
    const snapshotDir = mkdtempSync(join(tmpdir(), 'committee-snapshots-'))
    const runner = await makeRunner(s, ev, snapshotDir)
    await toL2Pending(s, id)
    expect((await runPanel(s, runner)).routedTo).toBe(RState.Review)
    const { chain, a, b } = await consoles(snapshotDir)
    if (process.env.RECORD) await record(chain, id, snapshotDir)

    // reviewer A reads the case: the panel's labels and rationales, its snapshot
    const c = await a.case(id)
    expect(c.reviewable).toBe(true)
    expect(c.panel!.labels).toEqual(['YES', 'YES', 'YES'])
    expect(c.panel!.models!.every((m) => m.rationale.length > 0)).toBe(true)
    expect(c.evidence!.available).toBe(true)
    const panelHash = c.evidence!.evidenceHash

    // adds a source (a new snapshot through the snapshotter) and proposes on it
    const session = await a.snapshot(id, [NEWS])
    expect(session.evidenceHash).not.toBe(panelHash)
    expect((await a.case(id)).evidence!.items.map((i) => i.url)).toContain(NEWS)
    const { path, bundle } = await a.propose(id, 'YES', 'Final score 3-1: the home team scored more than 2 goals, so YES under the rules.')
    expect(bundle.evidenceURI).toBe(session.evidenceURI)

    // one signature: the console will not send it, and the contract would refuse it
    const one = await collect(bundle, chain)
    expect(one.enough).toBe(false)
    await expect(a.submit(path)).rejects.toThrow(ProposalError)
    await expect(chain.simulateReviewed(id, bundle.proposal, bundle.evidenceURI, one.valid)).rejects.toThrow()

    // reviewer B chooses the outcome on their own: a different choice is not signed
    await expect(b.sign(path, 'NO')).rejects.toThrow(ProposalError)
    await b.sign(path, 'YES')
    const hash = await b.submit(path)
    const receipt = await s.pc.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')
    expect(receipt.gasUsed).toBeLessThanOrEqual(loadGas().calls.submitReviewedProposal.limit)
    const [rec] = parseEventLogs({ abi: ResolutionOracleAbi, eventName: 'ProposalRecorded', logs: receipt.logs })
    expect(rec.args.evidenceURI).toBe(session.evidenceURI)
    expect(rec.args.evidenceHash).toBe(session.evidenceHash)
    expect(Number(rec.args.path)).toBe(3) // REVIEWED
    expect(Number(rec.args.outcome)).toBe(1) // YES
    expect((await resolution(s, id)).state).toBe(RState.Proposed)
  }, SCENARIO_MS)

  test('EarlyReview: the proposal is accepted and halts the market at its block', async () => {
    ev.injected = true // a flagged early check goes to EarlyReview
    const id = await listPinned(s)
    const snapshotDir = mkdtempSync(join(tmpdir(), 'committee-snapshots-'))
    const runner = await makeRunner(s, ev, snapshotDir)
    await toEarlyCheck(s, id)
    expect((await runPanel(s, runner)).routedTo).toBe(RState.EarlyReview)
    const { a, b } = await consoles(snapshotDir)
    const c = await a.case(id)
    expect(c.early).toBe(true)
    expect(c.panel!.injectionSuspected).toBe(true)
    const { path, bundle } = await a.propose(id, 'YES', 'The match is already decided 3-1 per the allow-listed feed; YES under the rules.')
    expect(bundle.proposal.early).toBe(true)
    await b.sign(path, 'YES')
    const receipt = await s.pc.waitForTransactionReceipt({ hash: await b.submit(path) })
    expect(receipt.status).toBe('success')
    const r = await resolution(s, id)
    expect(r.state).toBe(RState.Proposed)
    expect(r.haltedAt).toBe((await s.pc.getBlock({ blockNumber: receipt.blockNumber })).timestamp)
  }, SCENARIO_MS)
})
