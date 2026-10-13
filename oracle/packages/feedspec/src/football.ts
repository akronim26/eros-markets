import type { Evaluation, FeedSpec, JNode } from './index'

// Versioned API-Football adapter. The immutable FeedSpec target pins the fixture,
// competition, season, teams, kickoff and selected side. No name-based matching.
export const FOOTBALL_URL = 'https://v3.football.api-sports.io/fixtures?id={id}'
export type FootballBinding = {
  fixtureId: number; leagueId: number; season: number; homeTeamId: number
  awayTeamId: number; kickoff: number; selection: 'HOME' | 'AWAY'
}
const PREFIX = 'football-regulation-v1'
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0
export function footballTarget(b: FootballBinding): string {
  if (![b.fixtureId, b.leagueId, b.season, b.homeTeamId, b.awayTeamId, b.kickoff].every(integer)
    || b.homeTeamId === b.awayTeamId || !['HOME', 'AWAY'].includes(b.selection)) throw new Error('FOOTBALL_BINDING_INVALID')
  return [PREFIX, b.fixtureId, b.leagueId, b.season, b.homeTeamId, b.awayTeamId, b.kickoff, b.selection].join(':')
}
export function footballFeed(b: FootballBinding, authRef: string): FeedSpec {
  if (!/^0x[0-9a-fA-F]{64}$/.test(authRef) || /^0x0{64}$/.test(authRef)) throw new Error('FOOTBALL_AUTH_REQUIRED')
  return { urlTemplate: FOOTBALL_URL, urlParam: String(b.fixtureId), authRef,
    finalPath: 'erosFootball.status', finalValue: 'FINAL_REGULATION_V1',
    valuePath: 'erosFootball.winner', valueType: 0, decimals: 0, op: 0,
    // T is kickoff (trading halt), not an assertion that the match has ended.
    // These bounds must be authorized in registry globals before listing.
    target: footballTarget(b), bufferSecs: 7200, l1TimeoutSecs: 21600 }
}

class Invalid extends Error {}
const fail = (code: string): never => { throw new Invalid(code) }
const field = (node: JNode | undefined, key: string): JNode | undefined => node?.k === 'obj' ? node.v.get(key) : undefined
const text = (node: JNode | undefined) => node?.k === 'str' ? node.v : fail('FOOTBALL_FIELD_INVALID')
const number = (node: JNode | undefined): number => {
  if (node?.k !== 'num' || !/^(0|[1-9][0-9]*)$/.test(node.v) || !Number.isSafeInteger(Number(node.v))) return fail('FOOTBALL_FIELD_INVALID')
  return Number(node.v)
}
const flag = (node: JNode | undefined): boolean | null => node?.k === 'null' ? null
  : node?.k === 'bool' ? node.v : fail('FOOTBALL_WINNER_INVALID')
const empty = (node: JNode | undefined) => node?.k === 'arr' ? node.v.length === 0 : node?.k === 'obj' && node.v.size === 0
const result = (status: Evaluation['status'], code: string, valueLexeme = ''): Evaluation => ({ status, code, valueLexeme })

/** Called after the shared duplicate-key-rejecting JSON parser and HTTP/body checks. */
export function evaluateFootball(spec: FeedSpec, root: JNode): Evaluation {
  try {
    const parts = spec.target.split(':')
    if (parts.length !== 8 || parts[0] !== PREFIX) return fail('FOOTBALL_SPEC_INVALID')
    const [fixtureId, leagueId, season, homeTeamId, awayTeamId, kickoff] = parts.slice(1, 7).map(Number)
    const b = { fixtureId, leagueId, season, homeTeamId, awayTeamId, kickoff, selection: parts[7] } as FootballBinding
    if (footballTarget(b) !== spec.target || spec.urlTemplate !== FOOTBALL_URL || spec.urlParam !== String(fixtureId)
      || spec.finalPath !== 'erosFootball.status' || spec.finalValue !== 'FINAL_REGULATION_V1'
      || spec.valuePath !== 'erosFootball.winner' || spec.valueType !== 0 || spec.decimals !== 0 || spec.op !== 0
      || !/^0x[0-9a-fA-F]{64}$/.test(spec.authRef) || /^0x0{64}$/.test(spec.authRef)) return fail('FOOTBALL_SPEC_INVALID')

    if (!empty(field(root, 'errors'))) return fail('FOOTBALL_PROVIDER_ERROR')
    if (text(field(root, 'get')) !== 'fixtures') return fail('FOOTBALL_ENDPOINT_MISMATCH')
    const parameter = field(field(root, 'parameters'), 'id')
    if ((parameter?.k === 'str' ? parameter.v : String(number(parameter))) !== spec.urlParam) return fail('FOOTBALL_FIXTURE_MISMATCH')
    const response = field(root, 'response')
    if (number(field(root, 'results')) !== 1 || response?.k !== 'arr' || response.v.length !== 1
      || number(field(field(root, 'paging'), 'current')) !== 1 || number(field(field(root, 'paging'), 'total')) !== 1) return fail('FOOTBALL_RESULT_COUNT')
    const game = response.v[0], fixture = field(game, 'fixture'), league = field(game, 'league'), teams = field(game, 'teams')
    const home = field(teams, 'home'), away = field(teams, 'away')
    if (number(field(fixture, 'id')) !== fixtureId || number(field(league, 'id')) !== leagueId
      || number(field(league, 'season')) !== season || number(field(home, 'id')) !== homeTeamId
      || number(field(away, 'id')) !== awayTeamId) return fail('FOOTBALL_IDENTITY_MISMATCH')
    if (number(field(fixture, 'timestamp')) !== kickoff) return fail('FOOTBALL_SCHEDULE_CHANGED')
    // Conservative first release: regular-time FT only. Awarded, abandoned,
    // postponed, extra-time and shootout results need review; never default NO.
    if (text(field(field(fixture, 'status'), 'short')) !== 'FT') return result('NOT_READY', 'FOOTBALL_NOT_REGULATION_FINAL')
    const score = field(game, 'score'), fulltime = field(score, 'fulltime'), goals = field(game, 'goals')
    const h = number(field(fulltime, 'home')), a = number(field(fulltime, 'away'))
    if (h > 100 || a > 100 || h !== number(field(goals, 'home')) || a !== number(field(goals, 'away'))) return fail('FOOTBALL_SCORE_CONFLICT')
    for (const period of ['extratime', 'penalty']) for (const side of ['home', 'away']) {
      if (field(field(score, period), side)?.k !== 'null') return fail('FOOTBALL_NON_REGULATION_SCORE')
    }
    const winner = h > a ? 'HOME' : a > h ? 'AWAY' : 'DRAW'
    const hw = flag(field(home, 'winner')), aw = flag(field(away, 'winner'))
    if (winner === 'DRAW' ? hw !== null || aw !== null : hw !== (winner === 'HOME') || aw !== (winner === 'AWAY')) return fail('FOOTBALL_WINNER_CONFLICT')
    // Consensus/report evidence includes both verified scores, not just a bool.
    const valueLexeme = [...parts.slice(0, 7), winner, h, a].join(':')
    return result(winner === b.selection ? 'YES' : 'NO', 'OK', valueLexeme)
  } catch (error) {
    return result('ERROR', error instanceof Invalid ? error.message : 'FOOTBALL_SPEC_INVALID')
  }
}
