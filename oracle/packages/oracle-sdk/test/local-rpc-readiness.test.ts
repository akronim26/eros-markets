import { expect, test } from 'bun:test'
import { retryLocalRead, waitForLocalFinality } from '../scripts/local-rpc-readiness'

test('known data-unavailable read is retried, while contract and unrelated RPC failures are not', async () => {
  let reads = 0, sleeps = 0
  const result = await retryLocalRead(async () => {
    if (++reads < 3) throw { cause: { details: 'Required data unavailable' } }
    return 123n
  }, async () => { sleeps++ })
  expect(result).toBe(123n)
  expect(reads).toBe(3)
  expect(sleeps).toBe(2)
  for (const failure of [new Error('execution reverted'), { details: 'connection refused' }]) {
    reads = 0
    await expect(retryLocalRead(async () => { reads++; throw failure }, async () => {})).rejects.toBe(failure)
    expect(reads).toBe(1)
  }
})

test('persistent data-unavailable reads have a finite retry budget', async () => {
  let reads = 0
  const error = { details: 'Required data unavailable' }
  await expect(retryLocalRead(async () => { reads++; throw error }, async () => {}, 3)).rejects.toBe(error)
  expect(reads).toBe(3)
})

test('receipt finality is awaited and its canonical block is checked before continuing', async () => {
  const calls: unknown[] = []
  let finalized = 9n
  await waitForLocalFinality({ getBlock: async args => {
    calls.push(args)
    return args.blockTag ? { number: finalized++, hash: '0x12' } : { number: 10n, hash: '0x12' }
  } }, { blockNumber: 10n, blockHash: '0x12' }, async () => {})
  expect(calls).toEqual([{ blockTag: 'finalized' }, { blockTag: 'finalized' }, { blockNumber: 10n }])
  await expect(waitForLocalFinality({ getBlock: async () => ({ number: 10n, hash: '0x13' }) },
    { blockNumber: 10n, blockHash: '0x12' }, async () => {})).rejects.toThrow('SDK_RECEIPT_REORGED')
})

test('a receipt that never finalizes fails closed without continuing the dependent transaction sequence', async () => {
  await expect(waitForLocalFinality({ getBlock: async () => ({ number: 9n, hash: '0x12' }) },
    { blockNumber: 10n, blockHash: '0x12' }, async () => {}, 3)).rejects.toThrow('SDK_FINALITY_TIMEOUT')
})
