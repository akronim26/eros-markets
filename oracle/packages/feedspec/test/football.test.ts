import { expect, test } from 'bun:test'
import { evaluateResponse, validateSpec, BadFeed, type FeedSpec } from '../src'
import { footballFeed, footballTarget } from '../src/football'
import { binding, feed, footballAuth, footballResponse } from './fixtures/football'
const evaluate = (body: unknown, spec: FeedSpec = feed, status = 200) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return evaluateResponse(spec, status, raw, new TextEncoder().encode(raw).length)
}
test('regular-time home, away and draw scores resolve the selected side and bind evidence', () => {
  for (const selection of ['HOME', 'AWAY'] as const) for (const [h, a] of [[2, 1], [0, 3], [1, 1]]) {
    const spec = footballFeed({ ...binding, selection }, footballAuth)
    const winner = h > a ? 'HOME' : h < a ? 'AWAY' : 'DRAW'
    const out = evaluate(footballResponse(h, a), spec)
    expect(out.status).toBe(winner === selection ? 'YES' : 'NO')
    expect(out.valueLexeme).toBe([...footballTarget(binding).split(':').slice(0, 7), winner, h, a].join(':'))
  }
})
test('live, postponed, cancelled, abandoned, awarded, extra-time and shootout games never resolve', () => {
  for (const status of ['NS', 'TBD', '1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'AET', 'PEN'])
    expect(evaluate(footballResponse(2, 1, status)).status).toBe('NOT_READY')
})
test('wrong fixture, competition, season, teams and changed kickoff produce no outcome', () => {
  for (const mutate of [
    (r: any) => r.parameters.id = '999000002',
    (r: any) => r.response[0].fixture.id++,
    (r: any) => r.response[0].fixture.timestamp++,
    (r: any) => r.response[0].league.id++,
    (r: any) => r.response[0].league.season++,
    (r: any) => r.response[0].teams.home.id++,
    (r: any) => r.response[0].teams.away.id++,
  ]) { const r = footballResponse(); mutate(r); expect(evaluate(r).status).toBe('ERROR') }
})
test('missing, contradictory or extra-time scores and winner flags never become NO', () => {
  for (const mutate of [
    (r: any) => r.response[0].score.fulltime.home = null,
    (r: any) => r.response[0].score.fulltime.home = '2',
    (r: any) => r.response[0].score.fulltime.home = -1,
    (r: any) => r.response[0].goals.home++,
    (r: any) => r.response[0].teams.home.winner = false,
    (r: any) => r.response[0].teams.away.winner = true,
    (r: any) => r.response[0].score.penalty.home = 0,
    (r: any) => delete r.response[0].score.extratime,
    (r: any) => r.response[0].score.fulltime.home = 101,
  ]) { const r = footballResponse(); mutate(r); expect(evaluate(r).status).toBe('ERROR') }
})
test('provider errors in HTTP 200, absent/duplicate results and pagination fail closed', () => {
  for (const mutate of [
    (r: any) => r.errors = { token: 'missing' },
    (r: any) => r.errors = ['quota exceeded'],
    (r: any) => r.results = 0,
    (r: any) => r.response = [],
    (r: any) => r.response.push(r.response[0]),
    (r: any) => r.paging.total = 2,
    (r: any) => r.get = 'predictions',
  ]) { const r = footballResponse(); mutate(r); expect(evaluate(r).status).toBe('ERROR') }
  for (const code of [401, 403, 429, 500]) expect(evaluate({}, feed, code).status).toBe('ERROR')
})
test('malformed and duplicate-key JSON cannot bypass validation', () => {
  expect(evaluate('{').status).toBe('ERROR')
  expect(evaluate(JSON.stringify(footballResponse()).replace('"results":1', '"results":0,"results":1')).code).toBe('DUPLICATE_KEY')
})
test('only the pinned, versioned specification and authentic provider URL are accepted', () => {
  for (const change of [
    { urlTemplate: 'https://evil.example/fixtures?id={id}' }, { urlParam: '999000002' },
    { target: feed.target + ':extra' }, { target: feed.target.replace(':101:', ':0101:') },
    { target: feed.target.replace(':HOME', ':DRAW') }, { op: 1 }, { valueType: 1 },
    { finalValue: 'AET' }, { valuePath: 'response[0].teams.home.winner' },
    { authRef: '0x' + '00'.repeat(32) },
  ]) expect(evaluate(footballResponse(), { ...feed, ...change }).status).toBe('ERROR')
})
test('football needs a longer L1 window than the historical one-hour deployment globals', () => {
  const old = { bufferMinSecs: 60, bufferMaxSecs: 600, l1TimeoutMinSecs: 120, l1TimeoutMaxSecs: 3600 }
  expect(validateSpec(feed, 'v3.football.api-sports.io', true, old)).toBe(BadFeed.TIMING)
  expect(validateSpec(feed, 'v3.football.api-sports.io', true,
    { ...old, bufferMaxSecs: 7200, l1TimeoutMaxSecs: 21600 })).toBe(BadFeed.OK)
})
