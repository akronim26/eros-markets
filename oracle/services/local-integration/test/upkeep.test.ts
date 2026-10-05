import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { planUpkeep, upkeepGas, UpkeepStore, type UpkeepState } from '../src/upkeep'

const state: UpkeepState = { timestamp: 100n, scheduledT: 10000n, halted: false, work: 0, epochEnd: 200n, cursor: 0n, count: 2n,
  marketOrderEpoch: 1n, indexAvailable: true, monitorRestricted: false }
const memory = { marketOrderEpoch: '1', initialized: true, orders: { buyer: 7, seller: 9 }, quoteEpoch: '2', quoted: [] }
const binding = `0x${'12'.repeat(32)}` as Hex

describe('local bounded epoch upkeep', () => {
  test('does not act before epoch end or after halt, and never quotes in once mode', () => {
    expect(planUpkeep(state, memory, false)).toBeNull()
    expect(planUpkeep({ ...state, halted: true }, memory, true)).toBeNull()
    expect(planUpkeep({ ...state, timestamp: state.scheduledT }, memory, true)).toBeNull()
  })
  test('chooses actual bounded begin/page/finish operations', () => {
    expect(planUpkeep({ ...state, timestamp: 200n }, memory, false)).toEqual({ action: 'beginRollover', actor: 'operator' })
    expect(planUpkeep({ ...state, work: 1 }, memory, true)).toEqual({ action: 'rollPage', actor: 'operator' })
    expect(planUpkeep({ ...state, work: 1, cursor: 2n }, memory, true)).toEqual({ action: 'finishRollover', actor: 'operator' })
    expect(planUpkeep({ ...state, work: 2 }, memory, true)).toBeNull()
  })
  test('re-quotes each fixture owner once and defers when INDEX or monitor forbids it', () => {
    expect(planUpkeep(state, memory, true)).toEqual({ action: 'quote', actor: 'buyer' })
    expect(planUpkeep(state, { ...memory, quoted: ['buyer'] }, true)).toEqual({ action: 'quote', actor: 'seller' })
    expect(planUpkeep(state, { ...memory, quoteEpoch: undefined }, true)).toBeNull()
    expect(planUpkeep({ ...state, indexAvailable: false }, memory, true)).toBeNull()
    expect(planUpkeep({ ...state, monitorRestricted: true }, memory, true)).toBeNull()
    expect(planUpkeep(state, { ...memory, initialized: false }, true)).toBeNull()
  })
  test('measures gas with upward headroom but never overrides the transaction cap', () => {
    expect(upkeepGas(100000n)).toBe(140000)
    expect(upkeepGas(30000000n)).toBe(30000000)
    expect(() => upkeepGas(0n)).toThrow()
    expect(() => upkeepGas(30000001n)).toThrow()
  })
  test('journals survive restart, refuse concurrent writers and changed binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eros-upkeep-'))
    const path = join(directory, 'journal.json')
    try {
      const store = new UpkeepStore(path, binding)
      expect(() => new UpkeepStore(path, binding)).toThrow()
      const journal = store.read()
      journal.markets.demo.orders.buyer = 123
      store.write(journal)
      store.close()
      const resumed = new UpkeepStore(path, binding)
      expect(resumed.read().markets.demo.orders.buyer).toBe(123)
      resumed.close()
      expect(() => new UpkeepStore(path, `0x${'34'.repeat(32)}`)).toThrow('BINDING_CHANGED')
      const modified = JSON.parse(readFileSync(path, 'utf8'))
      modified.pending = { market: 'demo', action: 'beginRollover', actor: 'operator', hash: binding, rawTransaction: '0x0102', data: '0x0102', gasLimit: 100000, estimate: '90000', plannedBlock: '1' }
      writeFileSync(path, JSON.stringify(modified))
      expect(() => new UpkeepStore(path, binding)).toThrow('SIGNED_BYTES_CHANGED')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
