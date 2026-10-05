// Lists scenario markets on finished MLB games: builds the listing input, runs `oracle-cli list` and the
// ListMarket script (its createMarket checks), then sends the lister's transaction. A market's id is
// keccak256(slug), known before listing, so services that need per-market config can get it first.
import { MarketRegistryAbi, ORACLE_ROOT, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, keccak256, toBytes } from 'viem'
import { at, env, pc, sendData } from './stack'

export const ZERO32 = `0x${'00'.repeat(32)}` as Hex

/** Finished games (MLB Stats API, 3 Oct 2026) with their final scores. */
export const GAMES = {
  849828: { away: 'Atlanta Braves', home: 'Los Angeles Dodgers', awayRuns: 3, homeRuns: 5, label: "NLDS 'B' Game 1" },
  849830: { away: 'San Diego Padres', home: 'Milwaukee Brewers', awayRuns: 2, homeRuns: 3, label: "NLDS 'A' Game 1" },
  849829: { away: 'Chicago White Sox', home: 'Cleveland Guardians', awayRuns: 3, homeRuns: 0, label: "ALDS 'B' Game 1" },
  849835: { away: 'New York Yankees', home: 'Tampa Bay Rays', awayRuns: 0, homeRuns: 1, label: "ALDS 'A' Game 1" },
} as const
export type GamePk = keyof typeof GAMES

/**
 * `feed`: `mlb` resolves through the Stats API; `blocked` points Layer 1 at a path that returns 404 (provider
 * down, so the market escalates to Layer 2); `http429` points it at httpbin.org/status/429.
 */
export type MarketSpec = {
  scenario: string
  tag: string
  game: GamePk
  side: 'home' | 'away'
  target: number
  feed: 'mlb' | 'blocked' | 'http429'
  tauIn: number // seconds from now
  liveness: { l1: number; auto: number; reviewed: number }
  l2DeadlineSecs: number
  voidSecs: number
  bufferSecs?: number
  l1TimeoutSecs?: number
  monitor?: Address
  /** A game Layer 1 reads instead of `game` (not finished: NOT_READY); `game` stays the reference. */
  feedGame?: number
  groupId?: Hex
  groupExclusive?: boolean
}

export type Listed = { spec: MarketSpec; id: Hex; slug: string; engine: Address; tau: bigint; tx: Hex; block: bigint; truth: 'YES' | 'NO' }

const TEMPLATE = join(ORACLE_ROOT, 'listings/inputs/mlb-849828-test.json')
const INPUTS = join(ORACLE_ROOT, 'listings/inputs/e2e')
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

export const truthOf = (s: MarketSpec): 'YES' | 'NO' => {
  const g = GAMES[s.game]
  return (s.side === 'home' ? g.homeRuns : g.awayRuns) > s.target ? 'YES' : 'NO'
}

export function slugOf(s: MarketSpec, tau: number) {
  return `eros-e2e-${s.scenario.toLowerCase()}-${s.tag}-${s.game}-${s.side}-gt-${s.target}-${tau}`
}

export function buildInput(s: MarketSpec, nowTs: number) {
  const g = GAMES[s.game]
  const tau = Math.ceil((nowTs + s.tauIn) / 60) * 60
  const team = s.side === 'home' ? g.home : g.away
  const input = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const m = input.marketInput
  const url = `https://statsapi.mlb.com/api/v1/schedule?gamePk=${s.game}`
  m.question = `Did the ${team} score more than ${s.target} runs against the ${s.side === 'home' ? g.away : g.home} in the 2026 ${g.label} on 3 October 2026 (MLB gamePk ${s.game})? [testnet ${s.scenario} test market]`
  m.rules =
    `TESTNET TEST MARKET for end-to-end scenario ${s.scenario}; the game has already been played.\n\n` +
    `This market resolves YES if the ${team} (${s.side}) scored more than ${s.target} runs in MLB game ${s.game} (gamePk), the 2026 ${g.label} between the ${g.away} (away) and the ${g.home} (home), played on 2026-10-03. It resolves NO if they scored ${s.target} runs or fewer.\n\n` +
    `Source and finality: the official MLB Stats API schedule entry for gamePk ${s.game} (${url}). The game counts as completed once that entry's status code (dates[0].games[0].status.codedGameState) is "F". The runs counted are the ${s.side} score (dates[0].games[0].teams.${s.side}.score) shown with that status.\n\n` +
    `Deadline: the scheduled resolution time T is ${iso(tau)}. If no official source shows the game as Final with a numeric ${team} score before the void deadline, the market resolves INVALID.`
  if (s.feedGame) m.rules = `TESTNET NOT_READY TEST: Layer 1 reads gamePk ${s.feedGame}, which is scheduled and not played at T, so the workflow must write nothing; the text below describes the reference game.\n\n${m.rules}`
  if (s.feed === 'http429') m.rules = `TESTNET 429 TEST: Layer 1 reads https://httpbin.org/status/429, which always answers 429, so the workflow must write nothing; the text below describes the reference game.\n\n${m.rules}`
  m.windowStart = iso(nowTs)
  m.windowEnd = iso(tau)
  m.tau = iso(tau)
  m.groupId = s.groupId ?? ZERO32
  m.groupExclusive = s.groupExclusive ?? false
  m.feed.valuePath = `dates[0].games[0].teams.${s.side}.score`
  m.feed.target = String(s.target)
  m.feed.bufferSecs = s.bufferSecs ?? 60
  m.feed.l1TimeoutSecs = s.l1TimeoutSecs ?? 120
  m.feed.urlParam = String(s.feedGame ?? s.game)
  m.allowList = ['statsapi.mlb.com']
  if (s.feed === 'blocked') m.feed.urlTemplate = 'https://statsapi.mlb.com/api/v1/blocked?gamePk={id}'
  if (s.feed === 'http429') {
    m.feed.urlTemplate = 'https://httpbin.org/status/{id}'
    m.feed.urlParam = '429'
    m.allowList = ['httpbin.org', 'statsapi.mlb.com']
  }
  m.uma.livenessL1 = s.liveness.l1
  m.uma.livenessAuto = s.liveness.auto
  m.uma.livenessReviewed = s.liveness.reviewed
  m.l2DeadlineSecs = s.l2DeadlineSecs
  m.voidSecs = s.voidSecs
  if (s.monitor) m.monitor = s.monitor
  input.slug = slugOf(s, tau)
  input.reference = { urlParam: String(s.game) }
  input.dryRun = { liveUrlParam: String(s.game) }
  return { input, tau, id: keccak256(toBytes(input.slug)) as Hex }
}

function run(cmd: string[], extra: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: ORACLE_ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...extra }, timeout: 600_000 })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} failed:\n${out.slice(-3000)}`)
  return out
}

/** The MLB schedule response for the game, captured once: the reference of a market whose feed is not MLB's. */
async function referenceFile(game: GamePk): Promise<string> {
  const path = join(INPUTS, `reference-${game}.json`)
  try {
    readFileSync(path)
  } catch {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?gamePk=${game}`)
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()))
  }
  return path
}

/** Builds, checks and lists one market; returns once the createMarket receipt is in. */
export async function listMarket(s: MarketSpec, prebuilt?: ReturnType<typeof buildInput>): Promise<Listed> {
  const built = prebuilt ?? buildInput(s, Number((await pc.getBlock()).timestamp))
  mkdirSync(INPUTS, { recursive: true })
  const inputPath = join(INPUTS, `${built.input.slug}.json`)
  writeFileSync(inputPath, JSON.stringify(built.input, null, 2))
  const cli = ['bun', 'packages/oracle-cli/src/cli.ts', 'list', '--input', inputPath, '--force']
  if (s.feed !== 'mlb') cli.push('--reference', await referenceFile(s.game))
  if (s.feed === 'http429') cli.push('--providers', 'httpbin.org,statsapi.mlb.com') // allowed on chain since globals v2
  run(cli)
  const out = run([process.env.FORGE ?? 'forge', 'script', 'script/ListMarket.s.sol', '--rpc-url', env('MONAD_TESTNET_RPC')], {
    PACK: `listings/${built.id}/pack.json`,
  }).split('\n')
  const i = out.findIndex((l) => l.includes('Lister transaction (the team Safe)'))
  if (i < 0) throw new Error('ListMarket printed no lister transaction')
  const data = out[i + 1].trim() as Hex
  const r = await sendData('LISTER', at('MarketRegistry'), data)
  const core = (await pc.readContract({ address: at('MarketRegistry'), abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [built.id] })) as { engine: Address }
  return { spec: s, id: built.id, slug: built.input.slug, engine: core.engine, tau: BigInt(built.tau), tx: r.transactionHash, block: r.blockNumber, truth: truthOf(s) }
}

export const RState = { None: 0, EarlyCheck: 1, EarlyReview: 2, L1Pending: 3, L2Pending: 4, Review: 5, Open: 6, Proposed: 7, Disputed: 8, Voided: 9, Final: 10 } as const
export const stateName = (n: number) => Object.entries(RState).find(([, v]) => v === n)?.[0] ?? String(n)

export async function resolution(id: Hex) {
  return (await pc.readContract({ address: at('ResolutionOracle'), abi: ResolutionOracleAbi, functionName: 'getResolution', args: [id] })) as {
    state: number
    proposed: number
    path: number
    attempts: number
    rejectedMask: number
    outcome: number
    finalReason: number
    voided: boolean
    haltedAt: bigint
    voidDeadline: bigint
    l2StartedAt: bigint
    retryOpensAt: bigint
    assertionId: Hex
    assertionVenue: Address
    bond: bigint
    proposer: Address
    rewardAtoms: bigint
  }
}

/** Polls until `ok(resolution)` holds; throws after `timeoutSecs`. */
export async function waitFor(id: Hex, what: string, ok: (r: Awaited<ReturnType<typeof resolution>>) => boolean, timeoutSecs: number, log: (m: string) => void) {
  const end = Date.now() + timeoutSecs * 1000
  let last = -1
  for (;;) {
    let r: Awaited<ReturnType<typeof resolution>>
    try {
      r = await resolution(id)
    } catch (e) {
      log(`${id.slice(0, 10)} read failed, retrying: ${String(e).split('\n')[0]}`)
      await Bun.sleep(10_000)
      continue
    }
    if (r.state !== last) log(`${id.slice(0, 10)} state ${stateName(r.state)}`)
    last = r.state
    if (ok(r)) return r
    if (Date.now() > end) throw new Error(`${id.slice(0, 10)}: timed out waiting for ${what} (state ${stateName(r.state)})`)
    await Bun.sleep(20_000)
  }
}
