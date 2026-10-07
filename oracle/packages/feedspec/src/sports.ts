import type { Evaluation, FeedSpec, JNode } from './index'
import { API_SPORTS_PROVIDERS } from './api-sports'

/** One immutable rule format; provider adapters only validate and normalize facts. */
export type Sport = typeof API_SPORTS_PROVIDERS[number]['id']
export type SportsPredicate = { kind: 'winner'; participant: number } | { kind: 'draw' }
  | { kind: 'total-over'; halfPoints: number } | { kind: 'top-n'; participant: number; n: number }
export type SportsBinding = {
  version: 1; sport: Sport; eventId: number; competition: string; season: string
  kickoff: number; participants: number[]; scope: 'regulation' | 'official'; predicate: SportsPredicate
}
type Facts = { scores?: number[]; winner?: number | null; ranks?: [number, number][] }
class Invalid extends Error {}
const fail = (code: string): never => { throw new Invalid(code) }
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0
const f = (node: JNode | undefined, key: string): JNode | undefined => node?.k === 'obj' ? node.v.get(key) : undefined
const str = (node: JNode | undefined): string => node?.k === 'str' ? node.v : fail('SPORTS_FIELD_INVALID')
const num = (node: JNode | undefined): number => {
  if (node?.k !== 'num' || !/^(0|[1-9][0-9]*)$/.test(node.v) || !Number.isSafeInteger(Number(node.v))) return fail('SPORTS_FIELD_INVALID')
  return Number(node.v)
}
const scalar = (node: JNode | undefined): string => node?.k === 'str' ? node.v : String(num(node))
const flag = (node: JNode | undefined) => node?.k === 'bool' ? node.v : node?.k === 'null' ? null : fail('SPORTS_WINNER_INVALID')
const empty = (node: JNode | undefined) => node?.k === 'arr' ? node.v.length === 0 : node?.k === 'obj' && node.v.size === 0
const score = (node: JNode | undefined) => { const n = num(node); if (n > 10000) fail('SPORTS_SCORE_INVALID'); return n }
const timestamp = (node: JNode | undefined) => {
  const s = str(node)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?(?:Z|\+00:00)$/.test(s)) return fail('SPORTS_DATE_INVALID')
  const n = Date.parse(s) / 1000
  if (!positive(n)) return fail('SPORTS_DATE_INVALID')
  return n
}
const pending = (code = 'SPORTS_NOT_FINAL'): Evaluation => ({ status: 'NOT_READY', code, valueLexeme: '' })

export function sportsTarget(b: SportsBinding): string {
  if (b.version !== 1 || !API_SPORTS_PROVIDERS.some(p => p.id === b.sport) || !positive(b.eventId) || !positive(b.kickoff)
    || !/^[A-Za-z0-9][A-Za-z0-9 &'()._-]{0,63}$/.test(b.competition) || !/^\d{4}$/.test(b.season)
    || !Array.isArray(b.participants) || b.participants.length < 2 || b.participants.length > 40
    || !b.participants.every(positive) || new Set(b.participants).size !== b.participants.length
    || !['regulation', 'official'].includes(b.scope)) return fail('SPORTS_BINDING_INVALID')
  if (b.sport !== 'formula-1' && b.participants.length !== 2) return fail('SPORTS_BINDING_INVALID')
  // Football v1 uses the score after 90 minutes + stoppage time. Other sports
  // use their official full-game result, including overtime/extra innings.
  if ((b.sport === 'football') !== (b.scope === 'regulation')) return fail('SPORTS_SCOPE_UNSUPPORTED')
  const p = b.predicate
  let predicate: unknown[]
  if (p?.kind === 'winner' && b.participants.includes(p.participant)) predicate = ['winner', p.participant]
  else if (p?.kind === 'draw' && !['formula-1', 'mma', 'nba', 'volleyball', 'baseball'].includes(b.sport)) predicate = ['draw']
  else if (p?.kind === 'total-over' && Number.isSafeInteger(p.halfPoints) && p.halfPoints >= 0 && p.halfPoints <= 40000
    && !['formula-1', 'mma'].includes(b.sport)) predicate = ['total-over', p.halfPoints]
  else if (p?.kind === 'top-n' && b.sport === 'formula-1' && b.participants.includes(p.participant)
    && positive(p.n) && p.n <= b.participants.length) predicate = ['top-n', p.participant, p.n]
  else return fail('SPORTS_PREDICATE_UNSUPPORTED')
  return JSON.stringify(['sports-v1', b.sport, b.eventId, b.competition, b.season, b.kickoff, b.participants, b.scope, predicate])
}

function bindingOf(spec: FeedSpec): SportsBinding {
  const a = JSON.parse(spec.target), p = a[8]
  const b: SportsBinding = { version: 1, sport: a[1], eventId: a[2], competition: a[3], season: a[4], kickoff: a[5],
    participants: a[6], scope: a[7], predicate: p[0] === 'winner' ? { kind: 'winner', participant: p[1] }
      : p[0] === 'draw' ? { kind: 'draw' } : p[0] === 'total-over' ? { kind: 'total-over', halfPoints: p[1] }
        : { kind: p[0], participant: p[1], n: p[2] } }
  const expected = sportsFeed(b, spec.authRef)
  if (sportsTarget(b) !== spec.target || Object.keys(expected).some(k => expected[k as keyof FeedSpec] !== spec[k as keyof FeedSpec])) return fail('SPORTS_SPEC_INVALID')
  return b
}

export function sportsFeed(b: SportsBinding, authRef: string): FeedSpec {
  const target = sportsTarget(b)
  if (!/^0x[0-9a-fA-F]{64}$/.test(authRef) || /^0x0{64}$/.test(authRef)) return fail('SPORTS_AUTH_REQUIRED')
  const provider = API_SPORTS_PROVIDERS.find(p => p.id === b.sport)!
  const endpoint = b.sport === 'football' ? 'fixtures' : b.sport === 'formula-1' ? 'races' : b.sport === 'mma' ? 'fights' : 'games'
  return { urlTemplate: `https://${provider.host}/${endpoint}?id={id}`, urlParam: String(b.eventId), authRef,
    finalPath: 'erosSports.status', finalValue: 'FINAL_V1', valuePath: 'erosSports.predicate', valueType: 0, decimals: 0, op: 0,
    target, bufferSecs: 7200, l1TimeoutSecs: 21600 }
}

/** An exact same-host, same-race companion. Never accepts an arbitrary supplied URL. */
export function sportsCompanionUrl(spec: FeedSpec): string | null {
  if (spec.finalPath !== 'erosSports.status') return null
  const b = bindingOf(spec)
  return b.sport === 'formula-1' ? `https://v1.formula-1.api-sports.io/rankings/races?race=${b.eventId}` : null
}

function envelope(root: JNode, endpoint: string, parameter: string, id: number, multiple = false): JNode[] {
  if (!empty(f(root, 'errors'))) return fail('SPORTS_PROVIDER_ERROR')
  if (str(f(root, 'get')).replace(/\/$/, '') !== endpoint || scalar(f(f(root, 'parameters'), parameter)) !== String(id)) return fail('SPORTS_ENDPOINT_MISMATCH')
  const rows = f(root, 'response'), count = num(f(root, 'results')), paging = f(root, 'paging')
  if (rows?.k !== 'arr' || count !== rows.v.length || count < 1 || count > (multiple ? 40 : 1)) return fail('SPORTS_RESULT_COUNT')
  if (paging && (num(f(paging, 'current')) !== 1 || num(f(paging, 'total')) !== 1)) return fail('SPORTS_INCOMPLETE_PAGE')
  return rows.v
}
function identity(b: SportsBinding, id: number, competition: string, season: string, kickoff: number, ids: number[]) {
  if (id !== b.eventId || competition !== b.competition || season !== b.season || ids.join(',') !== b.participants.join(',')) return fail('SPORTS_IDENTITY_MISMATCH')
  if (kickoff !== b.kickoff) return fail('SPORTS_SCHEDULE_CHANGED')
}
function scored(b: SportsBinding, h: number, a: number): Facts {
  return { scores: [h, a], winner: h > a ? b.participants[0] : a > h ? b.participants[1] : null }
}
function addPeriods(nodes: (JNode | undefined)[], total: number) {
  let sum = 0
  for (const node of nodes) if (node?.k !== 'null') sum += score(node)
  if (sum !== total) return fail('SPORTS_SCORE_CONFLICT')
}

function normalizeTeamGame(b: SportsBinding, root: JNode): Facts | Evaluation {
  const g = envelope(root, b.sport === 'football' ? 'fixtures' : 'games', 'id', b.eventId)[0]
  const game = b.sport === 'football' ? f(g, 'fixture') : b.sport === 'american-football' ? f(g, 'game') : g
  const teams = f(g, 'teams'), home = f(teams, 'home'), away = f(teams, b.sport === 'nba' ? 'visitors' : 'away')
  const league = f(g, 'league')
  identity(b, num(f(game, 'id')), b.sport === 'nba' ? str(league) : scalar(f(league, 'id')),
    scalar(b.sport === 'nba' ? f(g, 'season') : f(league, 'season')),
    b.sport === 'nba' ? timestamp(f(f(g, 'date'), 'start')) : num(b.sport === 'american-football' ? f(f(game, 'date'), 'timestamp') : f(game, 'timestamp')),
    [num(f(home, 'id')), num(f(away, 'id'))])
  const status = scalar(f(f(game, 'status'), 'short'))
  const accepted = b.sport === 'nba' ? ['3'] : b.sport === 'hockey' ? ['FT', 'AOT', 'AP'] : ['FT']
  if (!accepted.includes(status)) return pending()
  const scores = f(g, b.sport === 'football' ? 'score' : 'scores')
  if (b.sport === 'football') {
    const full = f(scores, 'fulltime'), h = score(f(full, 'home')), a = score(f(full, 'away'))
    if (h !== score(f(f(g, 'goals'), 'home')) || a !== score(f(f(g, 'goals'), 'away'))) return fail('SPORTS_SCORE_CONFLICT')
    for (const period of ['extratime', 'penalty']) for (const side of ['home', 'away']) if (f(f(scores, period), side)?.k !== 'null') return pending('SPORTS_SCOPE_REVIEW')
    const facts = scored(b, h, a), hw = flag(f(home, 'winner')), aw = flag(f(away, 'winner'))
    if (h === a ? hw !== null || aw !== null : hw !== (h > a) || aw !== (a > h)) return fail('SPORTS_WINNER_CONFLICT')
    return facts
  }
  if (b.sport === 'nba') {
    const pair = ['home', 'visitors'].map(side => {
      const s = f(scores, side), total = score(f(s, 'points')), line = f(s, 'linescore')
      const periods = num(f(f(g, 'periods'), 'total'))
      if (periods < 4 || line?.k !== 'arr' || line.v.length !== periods) return fail('SPORTS_PERIODS_INVALID')
      let sum = 0
      for (const p of line.v) { const n = str(p); if (!/^(0|[1-9][0-9]{0,3})$/.test(n)) return fail('SPORTS_SCORE_INVALID'); sum += Number(n) }
      if (sum !== total) return fail('SPORTS_SCORE_CONFLICT')
      return total
    })
    if (pair[0] === pair[1]) return fail('SPORTS_IMPOSSIBLE_DRAW')
    return scored(b, pair[0], pair[1])
  }
  if (b.sport === 'baseball' || b.sport === 'american-football') {
    const pair = ['home', 'away'].map(side => {
      const s = f(scores, side), total = score(f(s, 'total'))
      if (b.sport === 'american-football') addPeriods(['quarter_1', 'quarter_2', 'quarter_3', 'quarter_4', 'overtime'].map(p => f(s, p)), total)
      else {
        const innings = f(s, 'innings')
        if (innings?.k !== 'obj' || innings.v.size < 1) return fail('SPORTS_PERIODS_INVALID')
        addPeriods([...innings.v.values()], total)
      }
      return total
    })
    if (b.sport === 'baseball' && pair[0] === pair[1]) return pending('SPORTS_TIE_REVIEW')
    return scored(b, pair[0], pair[1])
  }
  const h = score(f(scores, 'home')), a = score(f(scores, 'away')), periods = f(g, 'periods')
  if (b.sport === 'handball') for (const [side, total] of [['home', h], ['away', a]] as const)
    addPeriods(['first', 'second'].map(p => f(f(periods, p), side)), total)
  if (b.sport === 'hockey') {
    const sums = [0, 0]
    for (const p of ['first', 'second', 'third', 'overtime', 'penalties']) {
      const node = f(periods, p)
      if (node?.k === 'null') { if (['first', 'second', 'third'].includes(p)) return fail('SPORTS_PERIODS_INVALID'); continue }
      const match = /^(\d{1,3})-(\d{1,3})$/.exec(str(node))
      if (!match) return fail('SPORTS_PERIODS_INVALID')
      sums[0] += Number(match[1]); sums[1] += Number(match[2])
    }
    // Shootout score conventions vary; refuse inconsistent totals for review.
    if (sums[0] !== h || sums[1] !== a) return fail('SPORTS_SCORE_CONFLICT')
  }
  if (b.sport === 'volleyball') {
    const wins = [0, 0]
    for (const p of ['first', 'second', 'third', 'fourth', 'fifth']) {
      const set = f(periods, p), x = f(set, 'home'), y = f(set, 'away')
      if (x?.k === 'null' && y?.k === 'null') continue
      const hs = score(x), as = score(y)
      if (hs === as) return fail('SPORTS_SCORE_CONFLICT')
      wins[hs > as ? 0 : 1]++
    }
    if (h !== wins[0] || a !== wins[1] || h === a) return fail('SPORTS_SCORE_CONFLICT')
  }
  return scored(b, h, a)
}

function normalizeRace(b: SportsBinding, root: JNode, companion?: JNode): Facts | Evaluation {
  const race = envelope(root, 'races', 'id', b.eventId)[0]
  identity(b, num(f(race, 'id')), scalar(f(f(race, 'competition'), 'id')), scalar(f(race, 'season')), timestamp(f(race, 'date')), b.participants)
  if (str(f(race, 'type')) !== 'Race') return fail('SPORTS_RACE_TYPE_MISMATCH')
  if (str(f(race, 'status')) !== 'Completed') return pending()
  if (!companion) return pending('SPORTS_CLASSIFICATION_REQUIRED')
  const rows = envelope(companion, 'rankings', 'race', b.eventId, true)
  const ranks: [number, number][] = rows.map(row => {
    if (num(f(f(row, 'race'), 'id')) !== b.eventId) return fail('SPORTS_IDENTITY_MISMATCH')
    return [num(f(f(row, 'driver'), 'id')), num(f(row, 'position'))]
  })
  if (ranks.length !== b.participants.length || new Set(ranks.map(r => r[0])).size !== ranks.length
    || new Set(ranks.map(r => r[1])).size !== ranks.length || ranks.some(([id, rank]) => !b.participants.includes(id) || rank < 1 || rank > ranks.length)) return fail('SPORTS_CLASSIFICATION_INVALID')
  ranks.sort((a, b) => a[1] - b[1])
  return { ranks, winner: ranks[0][0] }
}

function normalizeFight(b: SportsBinding, root: JNode): Facts | Evaluation {
  const fight = envelope(root, 'fights', 'id', b.eventId)[0]
  const fighters = f(fight, 'fighters'), first = f(fighters, 'first'), second = f(fighters, 'second')
  const date = str(f(fight, 'date'))
  if (num(f(fight, 'timestamp')) !== timestamp(f(fight, 'date'))) return fail('SPORTS_DATE_CONFLICT')
  identity(b, num(f(fight, 'id')), str(f(fight, 'category')), date.slice(0, 4), timestamp(f(fight, 'date')),
    [num(f(first, 'id')), num(f(second, 'id'))])
  if (scalar(f(f(fight, 'status'), 'short')) !== 'FT') return pending()
  const one = flag(f(first, 'winner')), two = flag(f(second, 'winner'))
  // No-contest, overturned, missing and ambiguous draw flags require review.
  if (one === null || two === null || one === two) return pending('SPORTS_FIGHT_RESULT_REVIEW')
  return { winner: b.participants[one ? 0 : 1] }
}

export function evaluateSports(spec: FeedSpec, root: JNode, companion?: JNode): Evaluation {
  try {
    const b = bindingOf(spec)
    const facts = b.sport === 'formula-1' ? normalizeRace(b, root, companion) : b.sport === 'mma' ? normalizeFight(b, root) : normalizeTeamGame(b, root)
    if ('status' in facts) return facts
    const p = b.predicate
    const yes = p.kind === 'winner' ? facts.winner === p.participant : p.kind === 'draw' ? facts.winner === null
      : p.kind === 'total-over' ? facts.scores !== undefined && 2 * (facts.scores[0] + facts.scores[1]) > p.halfPoints
        : facts.ranks!.find(r => r[0] === p.participant)![1] <= p.n
    // Both identity and normalized evidence are included in consensus; never hash
    // only the resulting boolean. The on-chain report also binds the FeedSpec hash.
    return { status: yes ? 'YES' : 'NO', code: 'OK', valueLexeme: JSON.stringify([JSON.parse(spec.target), facts]) }
  } catch (e) { return { status: 'ERROR', code: e instanceof Invalid ? e.message : 'SPORTS_SPEC_INVALID', valueLexeme: '' } }
}
