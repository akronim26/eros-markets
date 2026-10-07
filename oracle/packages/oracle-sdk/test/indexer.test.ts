import { expect, test } from 'bun:test'
import { freshProgress, IndexerClient } from '../src/indexer'

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
