// Task O37.2: every entity populated from recorded events. The events are a real local deploy's (scripts/record.test.ts,
// fixture test/fixtures/recorded/events.json), replayed on Monad testnet's addresses through the real handlers
// (Envio's test indexer). Expected values come from the recorded scenario, not from the handlers: market A went
// L1 → Proposed → disputed by the watchdog's float → the sandbox DVM said untruthful → Review → voided at its
// voidDeadline; market B went Layer 2 → Review → the committee's REVIEWED proposal → Final.
import { createTestIndexer } from 'envio'
import { beforeAll, describe, expect, it } from 'vitest'
import { RECORDED, simulateItems, TESTNET } from './replay'

const A = RECORDED.markets.A.toLowerCase()
const B = RECORDED.markets.B.toLowerCase()
const DISPUTED = RECORDED.disputedAssertion.toLowerCase()
const AT = { number: 67_910_000, timestamp: 1_791_100_000 } // a block after every testnet start block
const BOND = 11_120_000n // max(minBond 2 USDC, 11.12% of the example's OI cap of 100 claims), in USDC atoms
let indexer: ReturnType<typeof createTestIndexer>

beforeAll(async () => {
  indexer = createTestIndexer()
  await indexer.process({ chains: { 10143: { simulate: simulateItems() as never } } })
})

const sorted = <T extends { block: number; id: string }>(rows: T[]) => [...rows].sort((x, y) => x.block - y.block || Number(x.id.split('-')[2]) - Number(y.id.split('-')[2]))

describe('Market and Resolution (state history)', () => {
  it('A: Layer 1 proposal disputed, rejected, then voided at voidDeadline', async () => {
    const m = await indexer.Market.getOrThrow(A)
    expect(m).toMatchObject({ hasFeed: true, state: 10, stateName: 'Final', live: false, attempts: 1, proposedOutcome: 1, proposedPath: 1, rejectedMask: 2, finalOutcome: 3, finalReason: 3, trustSetId: 1, requestCount: 1, oiHaltLots: 100_000n })
    expect(m.voidReason).toBeDefined()
    expect(m.assertion_id).toBeUndefined() // the rejected assertion is no longer the market's live one
    expect(m.voidDeadline! - m.haltedAt!).toBe(7200n) // the example pack's voidSecs
    const history = sorted((await indexer.Resolution.getAll()).filter((r) => r.market_id === A))
    expect(history.map((r) => [r.fromName, r.toName])).toEqual([['None', 'L1Pending'], ['L1Pending', 'Proposed'], ['Proposed', 'Disputed'], ['Disputed', 'Review'], ['Review', 'Voided'], ['Voided', 'Final']])
  })

  it('B: Layer 2, the committee proposes, Final YES', async () => {
    const m = await indexer.Market.getOrThrow(B)
    expect(m).toMatchObject({ state: 10, live: false, attempts: 1, proposedOutcome: 1, proposedPath: 3, finalOutcome: 1, finalReason: 1, rejectedMask: 0 })
    expect(m.evidenceURI).toBe(`eros-snapshot:${m.evidenceHash}`)
    const history = sorted((await indexer.Resolution.getAll()).filter((r) => r.market_id === B))
    expect(history.map((r) => r.toName)).toEqual(['L1Pending', 'L2Pending', 'Review', 'Proposed', 'Final'])
  })

  it('listing fields come from MarketListed', async () => {
    const [a, b] = [await indexer.Market.getOrThrow(A), await indexer.Market.getOrThrow(B)]
    expect(a.rulesHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a.rulesHash).toBe(b.rulesHash) // the same example rules
    expect(a.gateHash).not.toBe(b.gateHash) // B pins the panel harness's models, prompt and calibration
    expect(b.tau).toBeGreaterThan(a.tau)
  })
})

describe('Assertion, Dispute, Proposal, PanelResult', () => {
  it('A’s assertion: L1, the treasury as asserter, disputed by the treasury, settled untruthful, rejected', async () => {
    const x = await indexer.Assertion.getOrThrow(DISPUTED)
    expect(x).toMatchObject({ market_id: A, attempt: 0, venue: TESTNET.UmaAdapter, outcome: 1, path: 1, bond: BOND, liveness: 120n, asserter: TESTNET.BondTreasury, disputed: true, disputer: TESTNET.BondTreasury, settled: true, truthful: false, rejected: true, rejectedMask: 2 })
    expect(x.expiresAt - x.assertedAt).toBe(120n)
    expect(x.identifier).toBe('0x4153534552545f54525554480000000000000000000000000000000000000000') // "ASSERT_TRUTH"
  })

  it('the dispute: OOv3’s, synced by the oracle, funded by the watchdog float, closed', async () => {
    expect(await indexer.Dispute.getOrThrow(DISPUTED)).toMatchObject({ market_id: A, disputer: TESTNET.BondTreasury, caller: TESTNET.UmaAdapter, viaTreasury: true, treasuryBond: BOND, syncedByOracle: true, closed: true })
    expect(await indexer.Dispute.getAll()).toHaveLength(1)
  })

  it('B’s assertion: REVIEWED, reviewed liveness, settled truthful', async () => {
    const [x] = (await indexer.Assertion.getAll()).filter((a) => a.market_id === B)
    expect(x).toMatchObject({ attempt: 0, path: 3, outcome: 1, liveness: 300n, disputed: false, settled: true, truthful: true, rejected: false })
  })

  it('every proposal, from both paths', async () => {
    const ps = sorted(await indexer.Proposal.getAll())
    expect(ps.map((p) => [p.market_id, p.pathName, p.outcome, p.attempt])).toEqual([[A, 'L1', 1, 0], [B, 'REVIEWED', 1, 0]])
    expect(ps[0]!.valueHash).toBe('0x2a80e1ef1d7842f27f2e6be0972bb708b9a135c38860dbe73c27c3486c34f4de') // keccak256("3"), the reported value
    expect(ps[0]!.evidenceURI).toBeUndefined()
    expect(ps[1]!.evidenceURI).toMatch(/^eros-snapshot:0x[0-9a-f]{64}$/)
  })

  it('the panel result: three YES labels at the placeholder 4,900 bps, routed to Review', async () => {
    const [r] = await indexer.PanelResult.getAll()
    expect(r).toMatchObject({ market_id: B, phase: 2, labels: [1, 1, 1], calibratedBps: [4900, 4900, 4900], routedTo: 5, routedToName: 'Review' })
    expect(r!.evidenceURI).toBe(`eros-snapshot:${r!.evidenceHash}`)
  })
})

describe('TreasuryLedger, TrustSet, ReportAttempt, SandboxRequest, Watchdog', () => {
  it('every treasury movement in order', async () => {
    const rows = sorted(await indexer.TreasuryLedger.getAll())
    expect(rows.map((r) => [r.kind, r.ledger ?? null, r.market_id ?? null, r.amount])).toEqual([
      ['Deposited', 0, null, 1_000_000_000n], // FundTreasury: 1,000 USDC to ASSERTION
      ['Deposited', 1, null, 1_000_000_000n], // and to WATCHDOG_FLOAT
      ['ListingCommitted', 0, A, BOND],
      ['AssertionFunded', 0, A, BOND],
      ['DisputeFunded', 1, A, BOND],
      ['BondLost', 0, A, BOND],
      ['DisputeClosed', 1, null, 0n],
      ['Skimmed', null, null, 16_680_000n], // the float's dispute won: its bond back plus half the asserter's (UMA burns 50%)
      ['ListingCommitted', 0, B, BOND],
      ['AssertionFunded', 0, B, BOND],
      ['BondReturned', 0, B, BOND],
      ['ListingReleased', 0, B, BOND],
      ['ListingReleased', 0, A, BOND],
    ])
  })

  it('trust set 1 (sim) created and active', async () => {
    expect(await indexer.TrustSet.getAll()).toMatchObject([{ id: '1', production: false, active: true, revocations: [] }])
  })

  it('the CRE report to the oracle, through the sim forwarder, accepted', async () => {
    expect(await indexer.ReportAttempt.getAll()).toMatchObject([{ forwarder: TESTNET.KeystoneForwarder, receiver: TESTNET.ResolutionOracle, reportId: '0x0001', result: true }])
  })

  it('the sandbox DVM’s request and the team’s answer (0: untruthful)', async () => {
    expect(await indexer.SandboxRequest.getAll()).toMatchObject([{ identifier: '0x4153534552545f54525554480000000000000000000000000000000000000000', price: 0n }])
  })

  it('the watchdog’s heartbeat', async () => {
    expect(await indexer.Watchdog.getAll()).toMatchObject([{ beats: 1 }])
  })
})

describe('Category (governance; not in the recording)', () => {
  it('CategorySet sets and revokes a category', async () => {
    const t = createTestIndexer()
    const id = '0x1ad7df1d1e1d8d5fdc0ad2df1bba0d1b8e8a0b6d8c0a3c4b5e6f708192a3b4c5'
    const gate = `0x${'ab'.repeat(32)}`
    const set = (validated: boolean, n: number) => ({ contract: 'MarketRegistry', event: 'CategorySet', block: { ...AT, number: AT.number + n, timestamp: AT.timestamp + n }, params: { categoryId: id, gateHash: gate, u95Bps: 198n, sampleN: 150n, validated } })
    // one process() per test indexer: a second one cannot restart before the contracts' start blocks
    const r = await t.process({ chains: { 10143: { simulate: [set(true, 0), set(false, 1)] as never } } })
    expect(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toContain('"validated":true') // set first
    expect(await t.Category.getOrThrow(id)).toMatchObject({ gateHash: gate, u95Bps: 198, sampleN: 150n, validated: false, updatedAt: BigInt(AT.timestamp + 1) }) // then revoked
  })
})

describe('Watchdog heartbeats', () => {
  it('counts every beat and keeps the latest time', async () => {
    const t = createTestIndexer()
    const w = '0x89F4b64300000000000000000000000000000001'
    const beat = (n: number) => ({ contract: 'ResolutionOracle', event: 'WatchdogHeartbeat', block: { ...AT, number: AT.number + n }, params: { watchdog: w, at: BigInt(AT.timestamp + 600 * n) } })
    await t.process({ chains: { 10143: { simulate: [beat(0), beat(1), beat(2)] as never } } })
    expect(await t.Watchdog.getOrThrow(w.toLowerCase())).toMatchObject({ beats: 3, lastHeartbeat: BigInt(AT.timestamp + 1200) })
  })
})

describe('sources the handlers must ignore', () => {
  const other = '0x000000000000000000000000000000000000dEaD'

  it('an OOv3 assertion not made through this deployment’s adapter, and its dispute and settlement', async () => {
    const t = createTestIndexer()
    const assertionId = `0x${'cd'.repeat(32)}`
    await t.process({
      chains: {
        10143: {
          simulate: [
            { contract: 'OptimisticOracleV3', event: 'AssertionMade', block: AT, params: { assertionId, domainId: `0x${'00'.repeat(32)}`, claim: '0x', asserter: other, callbackRecipient: other, escalationManager: other, caller: other, expirationTime: 1n, currency: other, bond: 1n, identifier: `0x${'00'.repeat(32)}` } },
            { contract: 'OptimisticOracleV3', event: 'AssertionDisputed', block: AT, params: { assertionId, caller: other, disputer: other } },
            { contract: 'OptimisticOracleV3', event: 'AssertionSettled', block: AT, params: { assertionId, bondRecipient: other, disputed: true, settlementResolution: false, settleCaller: other } },
          ] as never,
        },
      },
    })
    expect(await t.Assertion.getAll()).toEqual([])
    expect(await t.Dispute.getAll()).toEqual([])
  })

  it('a report to another receiver is not kept; a refused report to the oracle is (it is an alert)', async () => {
    const t = createTestIndexer()
    const report = (receiver: string) => ({ contract: 'KeystoneForwarder', event: 'ReportProcessed', block: AT, params: { receiver, workflowExecutionId: `0x${'11'.repeat(32)}`, reportId: '0x0001', result: false } })
    await t.process({ chains: { 10143: { simulate: [report(other), report(TESTNET.ResolutionOracle!)] as never } } })
    expect(await t.ReportAttempt.getAll()).toMatchObject([{ receiver: TESTNET.ResolutionOracle!, result: false }])
  })
})
