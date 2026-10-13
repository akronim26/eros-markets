import { describe, expect, test } from 'bun:test'
import fixtures from './fixtures/sports.json'
import notStarted from './fixtures/basketball-519655-ns.json'
import { evaluateResponse, type FeedSpec } from '../src'
import { sportsFeed, sportsTarget, type SportsBinding } from '../src/sports'

// api-sports basketball (v1.basketball.api-sports.io). Expected outcomes are read off the captured
// scores by hand (119 > 109 home), never from the evaluator under test.
const auth = '0x' + 'ab'.repeat(32)
const check = (feed: FeedSpec, response: unknown) => {
  const body = JSON.stringify(response)
  return evaluateResponse(feed, 200, body, body.length)
}
const finished = fixtures.find(f => f.binding.sport === 'basketball')!
const ftBinding = finished.binding as SportsBinding
const ftFeed = sportsFeed(ftBinding, auth)
const clone = (): any => structuredClone(finished.response)

// The listed native market: Miami Heat (147) at Golden State Warriors (141), tip-off 2026-11-06T03:00Z.
const heatAtWarriors: SportsBinding = { version: 1, sport: 'basketball', eventId: 519655, competition: '12',
  season: '2026-2027', kickoff: 1793934000, participants: [141, 147], scope: 'official',
  predicate: { kind: 'winner', participant: 141 } }

describe('Heat at Warriors binding', () => {
  test('pins the basketball host, the game id and the home-team-wins predicate', () => {
    const feed = sportsFeed(heatAtWarriors, auth)
    expect(feed.urlTemplate).toBe('https://v1.basketball.api-sports.io/games?id={id}')
    expect(feed.urlParam).toBe('519655')
    expect(JSON.parse(feed.target)).toEqual(['sports-v1', 'basketball', 519655, '12', '2026-2027', 1793934000,
      [141, 147], 'official', ['winner', 141]])
  })
  test('the captured not-started response matches the binding and is NOT_READY', () => {
    const r = check(sportsFeed(heatAtWarriors, auth), notStarted.response)
    expect(r.status).toBe('NOT_READY')
    expect(r.code).toBe('SPORTS_NOT_FINAL')
  })
  test('a captured response with a moved tip-off never resolves', () => {
    const moved: any = structuredClone(notStarted.response)
    moved.response[0].timestamp += 3600; moved.response[0].date = '2026-11-06T04:00:00+00:00'
    expect(check(sportsFeed(heatAtWarriors, auth), moved).code).toBe('SPORTS_SCHEDULE_CHANGED')
  })
})

describe('basketball final results', () => {
  test('captured FT (Jazz 119-109 Spurs): home YES, away NO', () => {
    expect('paging' in finished.response).toBe(false) // by-id responses omit paging
    expect(check(ftFeed, finished.response).status).toBe('YES')
    const away = sportsFeed({ ...ftBinding, predicate: { kind: 'winner', participant: 158 } }, auth)
    expect(check(away, finished.response).status).toBe('NO')
  })
  test('AOT counts the overtime points (synthetic edit of the captured game)', () => {
    const r = clone(), g = r.response[0]
    g.status = { long: 'After Over Time', short: 'AOT', timer: null }
    g.scores.home.quarter_4 = 10; g.scores.home.over_time = 8; g.scores.home.total = 117
    g.scores.away.over_time = 12; g.scores.away.total = 121
    // Regulation 109-109; home 33+35+31+10+8 = 117, away 26+35+17+31+12 = 121: away wins in overtime.
    expect(check(ftFeed, r).status).toBe('NO')
  })
  test('in-play, postponed, cancelled, suspended, abandoned and awarded games stay NOT_READY', () => {
    for (const short of ['NS', 'Q1', 'Q2', 'HT', 'Q3', 'Q4', 'OT', 'BT', 'POST', 'CANC', 'SUSP', 'ABD', 'AWD']) {
      const r = clone(); r.response[0].status.short = short
      expect(check(ftFeed, r).status).toBe('NOT_READY')
    }
  })
  test('inconsistent periods, scores and clocks are errors, never a payout', () => {
    const edits: ((g: any) => void)[] = [
      g => { g.scores.home.over_time = 0 },                       // FT with an overtime score
      g => { g.status.short = 'AOT' },                            // AOT without an overtime score
      g => { g.scores.home.total = 120 },                         // quarters do not sum to total
      g => { g.scores.away.quarter_2 = null },                    // missing regulation quarter
      g => { g.scores.home.total = 109; g.scores.home.quarter_4 = 10 }, // 109-109 draw
      g => { g.date = '2026-10-13T02:00:00+00:00' },              // date disagrees with timestamp
      g => { g.teams = { home: g.teams.away, away: g.teams.home } }, // teams swapped
      g => { g.league.season = '2025-2026' },
      g => { g.league.id = 20 },
    ]
    for (const edit of edits) {
      const r = clone(); edit(r.response[0])
      expect(check(ftFeed, r).status).toBe('ERROR')
    }
  })
})

describe('basketball binding rules', () => {
  test('split seasons must be consecutive years and are basketball-only', () => {
    expect(() => sportsTarget({ ...heatAtWarriors, season: '2026-2028' })).toThrow()
    expect(() => sportsTarget({ ...heatAtWarriors, season: '2026' })).not.toThrow()
    expect(() => sportsTarget({ ...heatAtWarriors, sport: 'nba', season: '2026-2027' })).toThrow()
  })
  test('basketball has no draw predicate', () => {
    expect(() => sportsTarget({ ...heatAtWarriors, predicate: { kind: 'draw' } })).toThrow()
  })
})
