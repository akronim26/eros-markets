import { expect, test } from 'bun:test'
import { evaluateResponse, Op, ValueType, type FeedSpec } from '../src'

const spec: FeedSpec = {
  urlTemplate: 'https://gamma-api.polymarket.com/markets/{id}', urlParam: '123', authRef: '0x' + '00'.repeat(32),
  finalPath: 'umaResolutionStatus', finalValue: 'resolved', valuePath: 'outcomePrices[0]',
  valueType: ValueType.INT, decimals: 0, op: Op.EQ, target: '1', bufferSecs: 60, l1TimeoutSecs: 300,
}
function evaluate(outcomePrices: unknown, status = 'resolved') {
  const body = JSON.stringify({ umaResolutionStatus: status, outcomePrices })
  return evaluateResponse(spec, 200, body, new TextEncoder().encode(body).length)
}
test('resolved Gamma YES and NO use exact indexed payout strings, independent of JSON whitespace', () => {
  expect(evaluate('["1", "0"]').status).toBe('YES')
  expect(evaluate('[ "0",\n"1" ]').status).toBe('NO')
  expect(evaluate(['1','0']).status).toBe('YES')
})
test('trading closure or a proposed result cannot resolve the market', () => {
  expect(evaluate('["1","0"]', 'proposed').status).toBe('NOT_READY')
  expect(evaluate('["1","0"]', '').status).toBe('NOT_READY')
})
test('fractional split payouts, malformed arrays, missing values and booleans produce no outcome', () => {
  for (const value of ['["0.5","0.5"]', '["1",', '[]', '[true,false]', 'not an array'])
    expect(evaluate(value).status).toBe('ERROR')
})
