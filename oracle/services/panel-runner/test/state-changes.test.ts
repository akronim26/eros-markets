import { expect, test } from 'bun:test'
import { stateChangeReader } from '../src/state-changes'

test('partial ranges resume at the immediately following block, including an unchanged head', async () => {
  let head = 105n
  const ranges: bigint[][] = []
  const read = stateChangeReader(100n, async () => head, async (from, to) => { ranges.push([from, to]); return [] })
  await read()
  await read()
  head = 109n
  await read()
  head = 310n
  await read()
  expect(ranges).toEqual([[100n, 105n], [106n, 109n], [110n, 209n], [210n, 309n], [310n, 310n]])
})

test('an RPC failure after an earlier range does not consume any undelivered events', async () => {
  let fail = true
  const ranges: bigint[][] = []
  const event = { id: `0x${'01'.repeat(32)}` as const, to: 4 }
  const read = stateChangeReader(100n, async () => 205n, async (from, to) => {
    ranges.push([from, to])
    if (from === 200n && fail) throw new Error('RPC unavailable')
    return from === 100n ? [event] : []
  })
  await expect(read()).rejects.toThrow('RPC unavailable')
  fail = false
  expect(await read()).toEqual([event])
  expect(ranges).toEqual([[100n, 199n], [200n, 205n], [100n, 199n], [200n, 205n]])
})
