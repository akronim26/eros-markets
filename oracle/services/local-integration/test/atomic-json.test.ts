import { expect, test } from 'bun:test'
import { replaceWithRetry } from '../src/atomic-json'

test('temporary sharing violations leave replacement pending until the reader closes', () => {
  let attempts = 0, waited = 0
  replaceWithRetry('next', 'current', (from, to) => {
    expect([from, to]).toEqual(['next', 'current'])
    if (++attempts < 4) throw Object.assign(new Error('reader open'), { code: 'EPERM' })
  }, ms => { waited += ms })
  expect(attempts).toBe(4)
  expect(waited).toBe(30)
})

test('a persistent sharing failure stays visible and an unrelated I/O error is not retried', () => {
  let attempts = 0
  expect(() => replaceWithRetry('next', 'current', () => {
    ++attempts; throw Object.assign(new Error('reader never closed'), { code: 'EACCES' })
  }, () => {})).toThrow('reader never closed')
  expect(attempts).toBe(100)
  expect(() => replaceWithRetry('next', 'current', () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  }, () => { throw new Error('must not wait') })).toThrow('disk full')
})
