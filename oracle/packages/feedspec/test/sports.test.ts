import { describe, expect, test } from 'bun:test'
import fixtures from './fixtures/sports.json'
import { evaluateResponse, type FeedSpec, type Status } from '../src'
import { sportsFeed, sportsTarget, sportsCompanionUrl, type SportsBinding } from '../src/sports'
import { nodeFetch, ZERO32 } from '../src/fetch'

const auth = '0x' + 'ab'.repeat(32)
const check = (feed: FeedSpec, response: unknown, companion?: unknown) => {
  const body = JSON.stringify(response), other = companion ? JSON.stringify(companion) : undefined
  return evaluateResponse(feed, 200, body, body.length, other ? { statusCode: 200, body: other, bodyBytes: other.length } : undefined)
}
for (const fixture of fixtures) describe(fixture.binding.sport, () => {
  const binding = fixture.binding as SportsBinding, feed = sportsFeed(binding, auth)
  test('authentic captured result resolves through the common predicate', () => {
    const result = check(feed, fixture.response, fixture.companion)
    expect(result.status).toBe(fixture.expected as Status)
    expect(result.valueLexeme).toContain(sportsTarget(binding))
    const opposite = sportsFeed({ ...binding, predicate: { kind: 'winner', participant: binding.participants[1] } }, auth)
    expect(check(opposite, fixture.response, fixture.companion).status).toBe(fixture.expected === 'YES' ? 'NO' : 'YES')
  })
  test('provider failures, incomplete pages and conflicting identities never resolve', () => {
    for (const response of [{ ...fixture.response, errors: { plan: 'Unavailable' } },
      { ...fixture.response, results: 2 }, { ...fixture.response, paging: { current: 1, total: 2 } },
      { ...fixture.response, parameters: { id: String(binding.eventId + 1) } }]) {
      expect(check(feed, response, fixture.companion).status).toBe('ERROR')
    }
    for (const changed of [{ ...binding, eventId: binding.eventId + 1 }, { ...binding, kickoff: binding.kickoff + 1 },
      { ...binding, competition: 'wrong' }, { ...binding, season: '1999' }]) {
      expect(check(sportsFeed(changed, auth), fixture.response, fixture.companion).status).toBe('ERROR')
    }
  })
  test('unknown, changed and noncanonical specifications cannot produce a payout', () => {
    for (const changed of [{ ...feed, urlTemplate: 'https://other.example/games?id={id}' },
      { ...feed, target: feed.target + ' ' }, { ...feed, valueType: 1 }, { ...feed, authRef: ZERO32 },
      { ...feed, finalValue: 'FT' }]) expect(check(changed, fixture.response, fixture.companion).status).toBe('ERROR')
  })
})

test('shared draw and exact half-point total predicates', () => {
  const fixture = fixtures.find(f => f.binding.sport === 'football')!, b = fixture.binding as SportsBinding
  const draw = sportsFeed({ ...b, predicate: { kind: 'draw' } }, auth)
  expect(check(draw, fixture.response).status).toBe('NO')
  for (const [halfPoints, result] of [[9, 'YES'], [10, 'NO'], [11, 'NO']] as const)
    expect(check(sportsFeed({ ...b, predicate: { kind: 'total-over', halfPoints } }, auth), fixture.response).status).toBe(result)
})

test('MMA weight-class labels and conflicting provider clocks are handled explicitly', () => {
  const fixture = fixtures.find(f => f.binding.sport === 'mma')!, b = fixture.binding as SportsBinding
  expect(() => sportsTarget({ ...b, competition: "Women's Bantamweight" })).not.toThrow()
  const response: any = structuredClone(fixture.response); response.response[0].timestamp++
  expect(check(sportsFeed(b, auth), response).code).toBe('SPORTS_DATE_CONFLICT')
})

test('rugby uses the same final-score predicate (synthetic schema fixture; no live evidence)', () => {
  const binding: SportsBinding = { version: 1, sport: 'rugby', eventId: 999000001, competition: '1', season: '2026',
    kickoff: 1791158400, participants: [101, 202], scope: 'official', predicate: { kind: 'winner', participant: 101 } }
  const response = { get: 'games', parameters: { id: '999000001' }, errors: [], results: 1,
    response: [{ id: 999000001, timestamp: binding.kickoff, league: { id: 1, season: 2026 },
      teams: { home: { id: 101 }, away: { id: 202 } }, status: { short: 'FT' }, scores: { home: 27, away: 24 } }] }
  expect(check(sportsFeed(binding, auth), response).status).toBe('YES')
  response.response[0].scores.away = 27
  expect(check(sportsFeed({ ...binding, predicate: { kind: 'draw' } }, auth), response).status).toBe('YES')
  response.response[0].status.short = 'PST'
  expect(check(sportsFeed(binding, auth), response).status).toBe('NOT_READY')
})

test('unfinished, cancelled, changed scores and ambiguous fights never default to NO', () => {
  for (const fixture of fixtures.filter(f => f.binding.sport !== 'formula-1')) {
    const b = fixture.binding as SportsBinding, feed = sportsFeed(b, auth)
    for (const status of ['NS', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'LIVE']) {
      const response: any = structuredClone(fixture.response), g = response.response[0]
      const game = b.sport === 'football' ? g.fixture : b.sport === 'american-football' ? g.game : g
      game.status.short = status
      expect(check(feed, response).status).toBe('NOT_READY')
    }
  }
  const nba = fixtures.find(f => f.binding.sport === 'nba')!, response: any = structuredClone(nba.response)
  response.response[0].scores.home.points++
  expect(check(sportsFeed(nba.binding as SportsBinding, auth), response).code).toBe('SPORTS_SCORE_CONFLICT')
  const mma = fixtures.find(f => f.binding.sport === 'mma')!, fight: any = structuredClone(mma.response)
  fight.response[0].fighters.first.winner = false; fight.response[0].fighters.second.winner = false
  expect(check(sportsFeed(mma.binding as SportsBinding, auth), fight).status).toBe('NOT_READY')
})

test('F1 requires completed race AND complete, unique classification from the same race', () => {
  const fixture = fixtures.find(f => f.binding.sport === 'formula-1')!, b = fixture.binding as SportsBinding
  const feed = sportsFeed({ ...b, predicate: { kind: 'top-n', participant: 10, n: 2 } }, auth)
  expect(check(feed, fixture.response).code).toBe('SPORTS_CLASSIFICATION_REQUIRED')
  expect(check(feed, fixture.response, fixture.companion).status).toBe('YES')
  expect(sportsCompanionUrl(feed)).toBe('https://v1.formula-1.api-sports.io/rankings/races?race=1857')
  for (const mutate of [(c: any) => c.response[0].race.id++, (c: any) => c.response[0].position = 2,
    (c: any) => c.response[0].driver.id = 123456, (c: any) => c.response.pop()]) {
    const c = structuredClone(fixture.companion); mutate(c)
    expect(check(feed, fixture.response, c).status).toBe('ERROR')
  }
  const response: any = structuredClone(fixture.response); response.response[0].status = 'Live'
  expect(check(feed, response, fixture.companion).status).toBe('NOT_READY')
})

test('CRE fetches the bound F1 classification only after race completion, with the same secret', () => {
  const fixture = fixtures.find(f => f.binding.sport === 'formula-1')!, feed = sportsFeed(fixture.binding as SportsBinding, auth)
  const urls: string[] = []
  const run = nodeFetch({ text: (r: { body: Uint8Array; statusCode: number }) => new TextDecoder().decode(r.body), hashLexeme: () => 'hash' })
  const result = run({ sendRequest(req) {
    urls.push(req.url); expect(req.multiHeaders['x-apisports-key'].values).toEqual(['test-only'])
    return { result: () => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify(urls.length === 1 ? fixture.response : fixture.companion)) }) }
  } }, feed, 'https://v1.formula-1.api-sports.io/races?id=1857', '8s', 'x-apisports-key', 'test-only')
  expect(result).toBe('YES|hash|OK')
  expect(urls).toEqual(['https://v1.formula-1.api-sports.io/races?id=1857', 'https://v1.formula-1.api-sports.io/rankings/races?race=1857'])
})
