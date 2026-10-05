import { expect, test } from 'bun:test'
import { keccak256, type Hex } from 'viem'
import { broadcastTracked } from '../src/broadcast'

const raw: Hex = '0x1234'
test('receipt-index lag can rebroadcast the exact already-mined transaction', async () => {
  const lookedUp: Hex[] = []
  const hash = await broadcastTracked(raw, {
    sendRawTransaction: async () => { throw new Error('nonce too low') },
    getTransaction: async ({ hash }) => { lookedUp.push(hash); return { hash } },
  })
  expect(hash).toBe(keccak256(raw))
  expect(lookedUp).toEqual([hash])
})

test('an unknown transaction or a different consumed nonce is never accepted', async () => {
  for (const getTransaction of [
    async () => { throw new Error('Transaction not found') },
    async () => ({ hash: keccak256('0xab') }),
  ]) {
    await expect(broadcastTracked(raw, {
      sendRawTransaction: async () => { throw new Error('nonce too low') }, getTransaction,
    })).rejects.toThrow()
  }
})

test('unrelated RPC errors still stop the sender', async () => {
  let lookedUp = false
  await expect(broadcastTracked(raw, {
    sendRawTransaction: async () => { throw new Error('RPC unavailable') },
    getTransaction: async () => { lookedUp = true; return { hash: keccak256(raw) } },
  })).rejects.toThrow('RPC unavailable')
  expect(lookedUp).toBe(false)
})
