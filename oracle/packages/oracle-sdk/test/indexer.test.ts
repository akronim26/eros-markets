import { expect, test } from 'bun:test'
import { freshProgress, gql, IndexerClient } from '../src/indexer'

const ready = { chainId: 10143, progressBlock: 100, sourceBlock: 100, isReady: true }
const client = (meta: unknown) => new IndexerClient('https://indexer.invalid', 10143,
  (async () => Response.json({ data: { _meta: [meta] } })) as unknown as typeof fetch)

test('only ready, correctly identified, integral indexer progress is usable', async () => {
  expect((await freshProgress(client(ready), 105n, 5n)).ok).toBe(true)
  for (const changes of [{ isReady: false }, { isReady: null }, { chainId: 1 },
    { progressBlock: -1 }, { progressBlock: 99.5 }, { progressBlock: Number.MAX_SAFE_INTEGER + 1 },
    { sourceBlock: 99 }, { sourceBlock: null }]) {
    expect((await freshProgress(client({ ...ready, ...changes }), 105n, 5n)).ok).toBe(false)
  }
})

test('repeating or unbounded indexer pages fail instead of stalling keeper fallback or returning partial IDs', async () => {
  let calls = 0
  const repeated = new IndexerClient('https://indexer.invalid', 10143,
    (async () => { calls++; return Response.json({ data: { Market: [{ id: 'one' }] } }) }) as unknown as typeof fetch)
  await expect(repeated.all('query', 'Market')).rejects.toThrow('repeated page')
  expect(calls).toBe(2)
  calls = 0
  const endless = new IndexerClient('https://indexer.invalid', 10143,
    (async () => Response.json({ data: { Market: [{ id: String(calls++) }] } })) as unknown as typeof fetch)
  await expect(endless.all('query', 'Market')).rejects.toThrow('page limit')
  expect(calls).toBe(1000)
  for (const size of [0, -1, 1.5, Number.NaN, 10001]) await expect(endless.all('query', 'Market', size)).rejects.toThrow('invalid page size')
  expect(calls).toBe(1000)
})

test('all failure paths exposed to service logs omit endpoint credentials and provider error text', async () => {
  const endpoint = 'https://user:private-password@indexer.invalid/private-path?key=private-key'
  const responses = [
    async () => { throw new Error(`failed request ${endpoint}`) },
    async () => new Response('', { status: 503 }),
    async () => Response.json({ errors: [{ message: `upstream denied ${endpoint}` }] }),
    async () => Response.json({}),
  ]
  for (const response of responses) {
    let message = ''
    try { await gql(endpoint, '{}', {}, response as unknown as typeof fetch) } catch (error) { message = (error as Error).message }
    expect(message).toStartWith('indexer:')
    expect(message).not.toContain('private-')
    expect(message).not.toContain(endpoint)
  }
  const bad = new IndexerClient(endpoint, 10143, (async () => Response.json({ data: { _meta: [] } })) as unknown as typeof fetch)
  const result = await freshProgress(bad, 105n, 5n)
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain('private-')
})
