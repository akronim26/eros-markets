import { expect, test } from 'bun:test'
import { LOCAL_SCENARIOS, summarizeCoverage } from '../src/local-coverage'

test('every mapped real-engine path must run once and pass; no failure or missing path is hidden', () => {
  const names = [...new Set(Object.values(LOCAL_SCENARIOS).flat())]
  const test_results = Object.fromEntries(names.map(name => [`${name}()`, { status: 'Success' }]))
  expect(summarizeCoverage({ real: { test_results } }).passed).toBeTrue()
  const failed = structuredClone(test_results)
  failed[`${names[0]}()`].status = 'Failure'
  expect(summarizeCoverage({ real: { test_results: failed } }).passed).toBeFalse()
  const missing = structuredClone(test_results)
  delete missing[`${names[0]}()`]
  expect(summarizeCoverage({ real: { test_results: missing } }).passed).toBeFalse()
  expect(summarizeCoverage({ real: { test_results }, duplicate: { test_results } }).passed).toBeFalse()
  expect(summarizeCoverage({}).passed).toBeFalse()
})
