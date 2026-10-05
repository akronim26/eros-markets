// Scenarios of plan §11.3 on Monad testnet. The running services do their own jobs (keeper: halt, request,
// escalate, assert, sync, finalize, void; CRE listener: Layer 1 reports; panel runner; watchdog); a scenario
// lists its markets, plays the remaining parties and checks the outcome. Sandbox DVM answers are scripted.
import { MarketRegistryAbi, ResolutionEngineStubAbi, ResolutionOracleAbi, TestUSDCAbi } from '@eros-oracle/oracle-sdk'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AbiEvent, type Address, type Hex, keccak256, parseAbiItem, parseEventLogs, stringToBytes } from 'viem'
import { committeePropose, committeeRefused, dvmAnswer, dvmRequestForLiveAssertion, dvmRequestOf, earlyCheck, proposePermissionless, publicDispute, simReport } from './actors'
import { Evidence } from './evidence'
import { buildInput, type GamePk, listMarket, type Listed, type MarketSpec, RState, resolution, stateName, truthOf, waitFor } from './market'
import { addr, at, d, env, now, pc, send } from './stack'

const OUTCOME = { YES: 1, NO: 2, INVALID: 3 } as const
const LIVE = { l1: 120, auto: 120, reviewed: 300 }
const mlbPage = (game: number) => `https://statsapi.mlb.com/api/v1/schedule?gamePk=${game}`
const WIKI_INJECTION = 'https://en.wikipedia.org/wiki/Prompt_injection'

/** Adds pages the panel runner snapshots for a market (its SOURCES file, re-read on every run). */
function addSources(id: Hex, pages: string[]) {
  const path = env('SOURCES')
  const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  all[id.toLowerCase()] = pages
  writeFileSync(path, JSON.stringify(all, null, 2))
}

async function list(ev: Evidence, s: MarketSpec, pages?: string[]): Promise<Listed> {
  const resume = process.env[`RESUME_${s.tag.replace(/-/g, '_').toUpperCase()}`] as Hex | undefined
  if (resume) {
    const c = (await pc.readContract({ address: at('MarketRegistry'), abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [resume] })) as { engine: Address; tau: bigint }
    ev.log(`resuming ${s.tag} on the listed market ${resume}`)
    return { spec: s, id: resume, slug: '(resumed)', engine: c.engine, tau: BigInt(c.tau), tx: '0x' as Hex, block: 0n, truth: truthOf(s) }
  }
  const built = buildInput(s, Number(await now()))
  if (pages) addSources(built.id, pages)
  const m = await listMarket(s, built)
  await ev.step(`listed ${s.tag} (truth ${m.truth}, T ${new Date(Number(m.tau) * 1000).toISOString()})`, { market: m.id, tx: m.tx, detail: { slug: m.slug, engine: m.engine, spec: s } })
  return m
}

async function settlement(engine: Address) {
  return (await pc.readContract({ address: engine, abi: ResolutionEngineStubAbi, functionName: 'getSettlementStatus' })) as {
    finalOutcome: number
    settlementPriceE18: bigint
    claimsEnabled: boolean
    oracleFinalityAccepted: boolean
  }
}

/** The oracle is Final with the outcome and the engine accepted it with claims open. The engine takes finality once:
 *  a repeat returns false and a conflicting outcome reverts, so an accepted outcome means one effective settle. */
async function finalChecks(ev: Evidence, m: Listed, want: 'YES' | 'NO' | 'INVALID') {
  const r = await resolution(m.id)
  const s = await settlement(m.engine)
  const engineWant = { YES: 2, NO: 1, INVALID: 3 }[want]
  ev.check(`${m.spec.tag} oracle Final ${want}`, r.state === RState.Final && r.outcome === OUTCOME[want], `state ${stateName(r.state)}, outcome ${r.outcome}, finalReason ${r.finalReason}`)
  ev.check(`${m.spec.tag} engine settled ${want}, claims open`, s.oracleFinalityAccepted && s.finalOutcome === engineWant && s.claimsEnabled, `engine finalOutcome ${s.finalOutcome}, price ${s.settlementPriceE18}, claimsEnabled ${s.claimsEnabled}`)
  return { r, s }
}

const say = (ev: Evidence) => (m: string) => ev.log(m)
const wait = (ev: Evidence, m: Listed, what: string, ok: Parameters<typeof waitFor>[2], secs: number) => waitFor(m.id, what, ok, secs, say(ev))
const final = (r: { state: number }) => r.state === RState.Final
const isState = (...s: number[]) => (r: { state: number }) => s.includes(r.state)
const liveAssertion = (r: { state: number; assertionId: Hex }) => r.state === RState.Proposed && r.assertionId !== `0x${'00'.repeat(32)}`

// ------------------------------------------------------------------ scenarios

/** O40.1 dry scenario: list → the keeper halts it at T. */
export async function dry(ev: Evidence) {
  const m = await list(ev, { scenario: 'DRY', tag: 'dry', game: 849835, side: 'home', target: 0, feed: 'mlb', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 6000 })
  const r = await wait(ev, m, 'halt', (x) => x.haltedAt > 0n, 1800)
  ev.check('keeper halted the market at T', r.haltedAt === m.tau, `haltedAt ${r.haltedAt}, T ${m.tau}, state ${stateName(r.state)}`)
}

/** E1: list → T → halt → request → CRE report → assert → 2-minute liveness → finalize → claims open. */
export async function e1(ev: Evidence) {
  const m = await list(ev, { scenario: 'E1', tag: 'e1', game: 849828, side: 'home', target: 3, feed: 'mlb', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 6000 })
  await wait(ev, m, 'Layer 1 proposal', (x) => x.state >= RState.Proposed, 1800)
  await wait(ev, m, 'Final', final, 1800)
  await finalChecks(ev, m, m.truth)
}

/** E8: fifteen markets sharing one T, all through Layer 1. */
export async function e8(ev: Evidence) {
  const base = Number(await now())
  const specs: MarketSpec[] = Array.from({ length: 15 }, (_, i) => ({
    scenario: 'E8', tag: `e8-${String(i).padStart(2, '0')}`, game: 849828 as GamePk, side: 'home' as const, target: i, feed: 'mlb' as const, tauIn: 2400, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 7200,
  }))
  const markets: Listed[] = []
  const resumed = process.env.RESUME_E8_IDS?.split(',') as Hex[] | undefined
  if (resumed) {
    for (const [i, id] of resumed.entries()) {
      const c = (await pc.readContract({ address: at('MarketRegistry'), abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [id] })) as { engine: Address; tau: bigint }
      markets.push({ spec: specs[i], id, slug: '(resumed)', engine: c.engine, tau: BigInt(c.tau), tx: '0x' as Hex, block: 0n, truth: truthOf(specs[i]) })
    }
    ev.log(`resuming on ${markets.length} listed markets`)
  }
  for (const s of resumed ? [] : specs) {
    const built = buildInput(s, base)
    const m = await listMarket(s, built)
    await ev.step(`listed ${s.tag} (truth ${m.truth})`, { market: m.id, tx: m.tx, detail: { slug: m.slug } })
    markets.push(m)
  }
  ev.check('all fifteen share one T', new Set(markets.map((m) => m.tau)).size === 1, `T ${markets[0].tau}`)
  await Promise.all(markets.map((m) => wait(ev, m, 'Final', final, 3600)))
  for (const m of markets) await finalChecks(ev, m, m.truth)
  const viaL1 = await Promise.all(markets.map(async (m) => (await resolution(m.id)).path))
  ev.check('every market resolved through Layer 1', viaL1.every((p) => p === 1), `paths ${viaL1.join(',')}`)
}

/**
 * One reviewed round, safe to resume: the committee proposes `outcome` if the market is in Review (skipped when
 * that outcome is already rejected), a third party disputes the live assertion, and the sandbox DVM answers
 * `truthful` (none for `null`). Each action runs only when the market is in the state before it.
 */
async function reviewedRound(ev: Evidence, m: Listed, outcome: 'YES' | 'NO', truthful: boolean | null, note: string, second: 2 | 3 = 2) {
  let r = await resolution(m.id)
  if (r.state === RState.Final || (r.rejectedMask & (1 << OUTCOME[outcome])) !== 0) return
  if (r.state === RState.Review || r.state === RState.EarlyReview) {
    await ev.step(`committee proposes ${outcome}`, { market: m.id, tx: await committeePropose(m.id, outcome, note, second) })
  }
  r = await wait(ev, m, 'live assertion or dispute', (x) => liveAssertion(x) || x.state === RState.Disputed || x.state === RState.Final, 1200)
  let request: Hex | undefined
  if (r.state === RState.Proposed) {
    const dispute = await publicDispute(m.id)
    await ev.step(`third party disputes ${outcome} on OOv3`, { market: m.id, tx: dispute.transactionHash })
    request = dvmRequestOf(dispute)
  }
  if (truthful === null) return
  r = await wait(ev, m, 'Disputed', isState(RState.Disputed, RState.Review, RState.Final), 900)
  if (r.state !== RState.Disputed) return
  request ??= await dvmRequestForLiveAssertion(m.id, BigInt(env('E2E_FROM_BLOCK')))
  await ev.step(`sandbox DVM answers ${truthful} to ${outcome}`, { market: m.id, tx: (await dvmAnswer(request, truthful)).transactionHash })
}

/** E2: provider down → escalate → panel → Review → committee → assert → public dispute → DVM true → Final. */
export async function e2(ev: Evidence) {
  const m = await list(ev, { scenario: 'E2', tag: 'e2', game: 849830, side: 'home', target: 2, feed: 'blocked', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 1800, voidSecs: 7200 }, [mlbPage(849830)])
  await wait(ev, m, 'Review (panel)', (x) => x.state >= RState.Review, 2400)
  await reviewedRound(ev, m, 'YES', true, 'E2: gamePk 849830 Final, Brewers 3 > 2: YES.')
  await wait(ev, m, 'Final', final, 1200)
  const { r } = await finalChecks(ev, m, 'YES')
  ev.check('path REVIEWED', r.path === 3, `path ${r.path}`)
  const q = await fetch(env('INDEXER_URL'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ Dispute(where: { market_id: { _eq: "${m.id}" } }) { id } }` }) })
  const j = (await q.json()) as { data?: { Dispute: unknown[] } }
  ev.check('dispute visible to Disputes Live (indexer)', (j.data?.Dispute.length ?? 0) > 0, JSON.stringify(j.data))
}

/** E3: as E2, but the DVM answers false → Review → the rejected outcome is refused → committee proposes the other → Final. */
export async function e3(ev: Evidence) {
  const m = await list(ev, { scenario: 'E3', tag: 'e3', game: 849829, side: 'home', target: 3, feed: 'blocked', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 2400, voidSecs: 7800 }, [mlbPage(849829)])
  await wait(ev, m, 'Review (panel)', (x) => x.state >= RState.Review, 2400)
  await reviewedRound(ev, m, 'YES', false, 'E3 scenario: proposal the sandbox DVM will reject.')
  const back = await wait(ev, m, 'Review after rejection', (x) => (x.rejectedMask & 2) !== 0 && x.state !== RState.Disputed, 1200)
  ev.check('rejectedMask set for YES', (back.rejectedMask & 2) !== 0, `rejectedMask ${back.rejectedMask}`)
  if (back.state === RState.Review) {
    const refused = committeeRefused(m.id, 'YES', 'E3: repeat of a rejected outcome (must be refused).')
    ev.check('the rejected outcome is not proposed again', !refused.startsWith('NOT REFUSED'), refused)
    await ev.step('committee proposes NO', { market: m.id, tx: await committeePropose(m.id, 'NO', 'E3: gamePk 849829 Final, Guardians 0, not more than 3: NO.') })
  }
  await wait(ev, m, 'Final', final, 1800)
  await finalChecks(ev, m, 'NO')
}

/** E4: YES rejected, then NO rejected → Voided → settleInvalid → the INVALID price. */
export async function e4(ev: Evidence) {
  const m = await list(ev, { scenario: 'E4', tag: 'e4', game: 849830, side: 'home', target: 2, feed: 'blocked', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 3000, voidSecs: 8400 }, [mlbPage(849830)])
  await wait(ev, m, 'Review (panel)', (x) => x.state >= RState.Review, 2400)
  await reviewedRound(ev, m, 'YES', false, 'E4 scenario: YES, which the sandbox DVM will reject.')
  await wait(ev, m, 'Review after the YES rejection', (x) => (x.rejectedMask & 2) !== 0 && x.state !== RState.Disputed, 1200)
  await reviewedRound(ev, m, 'NO', false, 'E4 scenario: NO, which the sandbox DVM will reject.')
  await wait(ev, m, 'Final (Voided)', final, 1200)
  const { r, s } = await finalChecks(ev, m, 'INVALID')
  ev.check('Voided after both outcomes were rejected', r.rejectedMask === 6, `rejectedMask ${r.rejectedMask}, finalReason ${r.finalReason}`)
  ev.check('INVALID payouts at the listed fallback price', s.settlementPriceE18 === 5n * 10n ** 17n, `price ${s.settlementPriceE18}`)
}

/** E5: no proposal by the L2 deadline → Open → permissionless proposal with own bond → Final; bond back and reward paid. */
export async function e5(ev: Evidence) {
  const m = await list(ev, { scenario: 'E5', tag: 'e5', game: 849835, side: 'home', target: 0, feed: 'blocked', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 300, voidSecs: 7200 }, [mlbPage(849835)])
  await wait(ev, m, 'Open (L2 deadline passed)', (x) => x.state >= RState.Open, 2400)
  if ((await resolution(m.id)).state === RState.Open) {
    const p = await proposePermissionless(m.id, OUTCOME[m.truth], 'KEEPER_1')
    await ev.step(`permissionless proposal ${m.truth} with own bond`, { market: m.id, tx: p.transactionHash })
  }
  const r = await wait(ev, m, 'Final', final, 1800)
  await finalChecks(ev, m, m.truth)
  ev.check('path PERMISSIONLESS, reward 1 USDC', r.path === 4 && r.rewardAtoms === 1_000_000n, `path ${r.path}, rewardAtoms ${r.rewardAtoms}`)
  // The proposer's balance also moves with other scenarios' disputes, so the payment is read from the treasury's
  // RewardPaid event and the bond transfer in the same (finalize) transaction.
  const paid = await findLog(at('BondTreasury'), parseAbiItem('event RewardPaid(bytes32 indexed id, address indexed proposer, uint256 amount)'), { id: m.id }, process.env.E5_LOG_FROM ? BigInt(process.env.E5_LOG_FROM) : m.block || (await pc.getBlockNumber()) - 3000n)
  if (!paid) {
    ev.check('reward paid to the proposer', false, 'no RewardPaid event for this market')
    return
  }
  const rc = await pc.getTransactionReceipt({ hash: paid.transactionHash })
  const transfer = parseEventLogs({ abi: TestUSDCAbi, eventName: 'Transfer', logs: rc.logs }) as { args: { from: Address; to: Address; amount: bigint } }[]
  const bondBack = transfer.find((t) => t.args.from.toLowerCase() === (d.uma.oov3 as string).toLowerCase() && t.args.to.toLowerCase() === paid.args.proposer.toLowerCase())
  ev.check('reward paid to the proposer (RewardPaid, no IOU)', paid.args.amount === 1_000_000n, `RewardPaid ${paid.args.amount} to ${paid.args.proposer} in ${paid.transactionHash}`)
  ev.check('bond returned to the proposer by OOv3', !!bondBack, bondBack ? `${bondBack.args.amount} atoms from OOv3 in ${paid.transactionHash}` : 'no OOv3 transfer to the proposer')
}

/** The first log of `event` from `address` with the given indexed args, scanning from `fromBlock` in 100-block steps. */
async function findLog<E extends AbiEvent>(address: Address, event: E, args: Record<string, unknown>, fromBlock: bigint) {
  const head = await pc.getBlockNumber()
  for (let b = fromBlock; b <= head; b += 100n) {
    const logs = await pc.getLogs({ address, event, args: args as never, fromBlock: b, toBlock: b + 99n > head ? head : b + 99n })
    if (logs.length) return logs[0] as unknown as { transactionHash: Hex; args: { proposer: Address; amount: bigint } }
  }
  return undefined
}

/** E7: a dispute that is never answered → voidMarket at voidDeadline → Final INVALID, stuck bond recorded. */
export async function e7(ev: Evidence) {
  const m = await list(ev, { scenario: 'E7', tag: 'e7', game: 849828, side: 'home', target: 3, feed: 'mlb', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 60, voidSecs: 5400 })
  const r1 = await wait(ev, m, 'live assertion', (x) => liveAssertion(x) || x.state === RState.Disputed || x.state === RState.Final, 1800)
  if (r1.state === RState.Proposed) {
    const dispute = await publicDispute(m.id)
    await ev.step('dispute on OOv3 (the DVM never answers)', { market: m.id, tx: dispute.transactionHash })
  }
  const r0 = await wait(ev, m, 'Disputed', isState(RState.Disputed, RState.Final), 900)
  ev.log(`voidDeadline ${new Date(Number(r0.voidDeadline) * 1000).toISOString()}`)
  const r = await wait(ev, m, 'Final (void)', final, 2 * 3600)
  await finalChecks(ev, m, 'INVALID')
  ev.check('voided at the void deadline', r.voided && r.finalReason === 3 && (await now()) >= r0.voidDeadline, `voided ${r.voided}, finalReason ${r.finalReason}, voidDeadline ${r0.voidDeadline}`)
  const from = process.env.E7_LOG_FROM ? BigInt(process.env.E7_LOG_FROM) : (await pc.getBlockNumber()) - 600n
  const stuck = await findLog(at('BondTreasury'), parseAbiItem('event BondStuck(bytes32 indexed id, uint8 attempt, uint256 amount)'), { id: m.id }, from)
  ev.check('the stuck bond is recorded (BondStuck)', !!stuck, stuck ? `BondStuck ${(stuck.args as unknown as { amount: bigint }).amount} atoms in ${stuck.transactionHash}` : 'no BondStuck event')
}

/** E6: monitor reduce-only → EarlyCheck → panel (flagged) → EarlyReview → committee → engine halts before T → Final before T. */
export async function e6(ev: Evidence) {
  const monitor = addr('KEEPER_1')
  const m = await list(ev, { scenario: 'E6', tag: 'e6', game: 849829, side: 'home', target: 3, feed: 'mlb', tauIn: 5400, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 9300, monitor }, [mlbPage(849829), WIKI_INJECTION])
  if ((await resolution(m.id)).state === RState.None) {
    for (const r of await earlyCheck(m.id, m.engine, 'KEEPER_1')) await ev.step('monitor: reduce-only, requestEarlyCheck', { market: m.id, tx: r.transactionHash })
  }
  const r1 = await wait(ev, m, 'EarlyReview (panel)', (x) => x.state === RState.EarlyReview || x.state >= RState.Proposed, 1800)
  if (r1.state === RState.EarlyReview) {
    await ev.step('committee proposes NO (early)', { market: m.id, tx: await committeePropose(m.id, 'NO', 'E6: gamePk 849829 Final, Guardians 0, not more than 3: NO.') })
  }
  const r = await wait(ev, m, 'Final', final, 1800)
  const t = await now()
  await finalChecks(ev, m, 'NO')
  ev.check('halted and Final before T', r.haltedAt < m.tau && t < m.tau, `haltedAt ${r.haltedAt}, Final by ${t}, T ${m.tau}`)
}

/** E9: exclusive group of three; two YES reports race; one asserts, the other conflicts; a single Final YES. */
export async function e9(ev: Evidence) {
  const groupId = (process.env.E9_GROUP as Hex | undefined) ?? keccak256(stringToBytes(`eros-e2e-e9-${await now()}`))
  const common = { scenario: 'E9', game: 849828 as GamePk, tauIn: 900, liveness: { l1: 300, auto: 300, reviewed: 300 }, l2DeadlineSecs: 1800, voidSecs: 7200, groupId, groupExclusive: true }
  const base = Number(await now())
  const m1spec: MarketSpec = { ...common, tag: 'e9-home-gt-4', side: 'home', target: 4, feed: 'mlb' }
  const m2spec: MarketSpec = { ...common, tag: 'e9-away-gt-4', side: 'away', target: 4, feed: 'blocked' }
  const m3spec: MarketSpec = { ...common, tag: 'e9-away-gt-9', side: 'away', target: 9, feed: 'mlb' }
  const ms: Listed[] = []
  const resumed = process.env.RESUME_E9_IDS?.split(',') as Hex[] | undefined
  if (resumed) {
    for (const [i, id] of resumed.entries()) {
      const spec = [m1spec, m2spec, m3spec][i]
      const c = (await pc.readContract({ address: at('MarketRegistry'), abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [id] })) as { engine: Address; tau: bigint }
      ms.push({ spec, id, slug: '(resumed)', engine: c.engine, tau: BigInt(c.tau), tx: '0x' as Hex, block: 0n, truth: truthOf(spec) })
    }
    ev.log('resuming on the listed group')
  }
  for (const s of resumed ? [] : [m1spec, m2spec, m3spec]) {
    const m = await listMarket(s, buildInput(s, base))
    await ev.step(`listed ${s.tag} (truth ${m.truth}, group ${groupId.slice(0, 10)})`, { market: m.id, tx: m.tx })
    ms.push(m)
  }
  const [m1, m2, m3] = ms
  if (!resumed) {
    await wait(ev, m1, 'Layer 1 YES proposed', (x) => x.state >= RState.Proposed, 1800)
    await wait(ev, m2, 'L1Pending', isState(RState.L1Pending), 600)
    const rep = await simReport(m2.id, 1, await now(), keccak256(stringToBytes('e9 racing YES')))
    await ev.step('a second YES report in the group (sim relayer through the mock forwarder)', { market: m2.id, tx: rep.transactionHash })
  }
  // The keeper treats assertProposal's `false` as a no-op, so it never applies a group conflict; anyone may.
  if ((await resolution(m2.id)).state === RState.Proposed && (await resolution(m1.id)).state === RState.Final) {
    const c = await send('KEEPER_1', at('ResolutionOracle'), ResolutionOracleAbi, 'assertProposal', [m2.id])
    await ev.step('group conflict applied: assertProposal on the racing market (a Final YES exists)', { market: m2.id, tx: c.transactionHash })
  }
  if (process.env.E9_CONFLICT_TX) {
    await ev.step('group conflict applied: assertProposal on the racing market by KEEPER_1 (the keeper skips it: it returns false)', { market: m2.id, tx: process.env.E9_CONFLICT_TX as Hex })
  }
  await Promise.all([wait(ev, m1, 'Final', final, 2400), wait(ev, m3, 'Final', final, 2400), wait(ev, m2, 'conflict resolved', (x) => x.state !== RState.Proposed, 2400)])
  await finalChecks(ev, m1, 'YES')
  await finalChecks(ev, m3, 'NO')
  const r2 = await resolution(m2.id)
  const g = (await pc.readContract({ address: at('ResolutionOracle'), abi: ResolutionOracleAbi, functionName: 'groupState', args: [groupId] })) as { finalYes: Hex }
  ev.check('single Final YES in the group (ORC-7)', g.finalYes.toLowerCase() === m1.id.toLowerCase() && !(r2.state === RState.Final && r2.outcome === 1), `finalYes ${g.finalYes}; racing market state ${stateName(r2.state)} outcome ${r2.outcome}`)
}

/** O23.2: a NOT_READY feed and a 429 feed are requested; the CRE listener must write nothing. */
export async function o23(ev: Evidence) {
  const notReady = await list(ev, { scenario: 'O23', tag: 'not-ready', game: 849828, feedGame: 849823, side: 'home', target: 3, feed: 'mlb', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 6000 })
  const http429 = await list(ev, { scenario: 'O23', tag: 'http-429', game: 849828, side: 'home', target: 3, feed: 'http429', tauIn: 660, liveness: LIVE, l2DeadlineSecs: 600, voidSecs: 6000 })
  for (const m of [notReady, http429]) {
    const r = await wait(ev, m, 'escalated past the L1 timeout', (x) => x.state >= RState.L2Pending, 1800)
    // The listener must have run on the request and written nothing: a request on chain and a no-write result
    // for this market in the CRE listener's logs (LISTEN_LOGS, the supervisor's log folder).
    const requests = Number(((await pc.readContract({ address: at('ResolutionOracle'), abi: ResolutionOracleAbi, functionName: 'getResolution', args: [m.id] })) as { requestCount: number }).requestCount)
    const dir = env('LISTEN_LOGS')
    const results = readdirSync(dir).filter((f) => f.startsWith('listen-')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n')).filter((l) => l.includes(`:${m.id}:`))
    const nowrite = results.find((l) => l.includes('nowrite:'))
    ev.check(`${m.spec.tag}: requested, the listener ran and wrote nothing`, requests > 0 && !!nowrite && r.path !== 1, `requests ${requests}; listener: ${nowrite?.trim() ?? 'no run logged'}; state ${stateName(r.state)}, path ${r.path}`)
  }
}

export const SCENARIOS: Record<string, { title: string; run: (ev: Evidence) => Promise<void> }> = {
  DRY: { title: 'dry scenario: list → halt through the deployed services', run: dry },
  O23: { title: 'Layer 1 no-write runs: NOT_READY and 429', run: o23 },
  E1: { title: 'Layer 1 to Final with a 2-minute liveness', run: e1 },
  E2: { title: 'provider down → panel → committee → public dispute → DVM true → Final', run: e2 },
  E3: { title: 'DVM false → Review → other outcome → Final', run: e3 },
  E4: { title: 'YES and NO rejected → Voided → INVALID', run: e4 },
  E5: { title: 'L2 deadline → Open → permissionless proposal → Final, reward paid', run: e5 },
  E6: { title: 'early check → EarlyReview → committee → Final before T', run: e6 },
  E7: { title: 'unanswered dispute → voidMarket at voidDeadline', run: e7 },
  E8: { title: 'fifteen markets sharing one T through Layer 1', run: e8 },
  E9: { title: 'exclusive group: racing YES reports, a single Final YES', run: e9 },
}
