import { expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { enqueue, nextRange, receiptIndex, validateCheckpoint, type Checkpoint, type Request } from './poller'

const hash = ('0x' + '12'.repeat(32)) as Hex
const request: Request = { tx: hash, block: '150', logIndex: 36, market: hash, retryAt: 0 }
const state: Checkpoint = { version: 1, chainId: 10143, oracle: ('0x' + '34'.repeat(20)) as Hex,
  broadcast: true, target: 'local-sim', nextBlock: '100', pending: [] }

test('a long outage catches up in inclusive ranges of at most 100 blocks without gaps', () => {
  let next = 100n
  const visited: bigint[] = []
  for (;;) {
    const range = nextRange(next, 1145n)
    if (!range) break
    const [from, to] = range
    expect(to - from + 1n).toBeLessThanOrEqual(100n)
    for (let n = from; n <= to; n++) visited.push(n)
    next = to + 1n
  }
  expect(visited).toEqual(Array.from({ length: 1046 }, (_, i) => BigInt(i + 100)))
  expect(nextRange(1146n, 1145n)).toBeUndefined()
})

test('cursor and queued event survive a JSON restart and replay is deduplicated', () => {
  const scanned = enqueue(state, [request], 199n, hash)
  const resumed = validateCheckpoint(JSON.parse(JSON.stringify(scanned)), state)
  expect(resumed.nextBlock).toBe('200')
  expect(resumed.pending).toEqual([request])
  expect(enqueue(resumed, [request], 199n, hash).pending).toHaveLength(1)
  expect(state.nextBlock).toBe('100') // failed saves leave original state unchanged
})

test('two requests in one transaction remain distinct and use receipt-local indexes', () => {
  const second = { ...request, logIndex: 39 }
  expect(enqueue(state, [request, second], 199n, hash).pending).toHaveLength(2)
  expect(receiptIndex([{ logIndex: 35 }, { logIndex: 36 }, { logIndex: 39 }], request)).toBe(1)
  expect(receiptIndex([{ logIndex: 35 }, { logIndex: 36 }, { logIndex: 39 }], second)).toBe(2)
  expect(() => receiptIndex([{ logIndex: 0 }], request)).toThrow('missing')
})

test('refuse to reuse checkpoints across chains, oracle addresses, targets or broadcast modes', () => {
  for (const bad of [{ chainId: 1 }, { oracle: '0x' + '56'.repeat(20) }, { target: 'staging' }, { broadcast: false }]) {
    expect(() => validateCheckpoint({ ...state, ...bad }, state)).toThrow('mismatch')
  }
})

test('corrupt checkpoints fail closed', () => {
  for (const bad of [null, {}, { ...state, nextBlock: '-1' }, { ...state, pending: [{}] },
    { ...state, anchor: { number: '97', hash } }, { ...state, pending: [{ ...request, retryAt: -1 }] }]) {
    expect(() => validateCheckpoint(bad, state)).toThrow()
  }
})
