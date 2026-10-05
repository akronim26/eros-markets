import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, type Hex } from 'viem'
import { planUpkeep, upkeepGas, UpkeepStore, type UpkeepState } from '../src/upkeep'

const state: UpkeepState = { timestamp: 100n, scheduledT: 10000n, halted: false, work: 0, epochId: 1n, epochEnd: 200n, cursor: 0n, count: 2n,
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
  test('an enrolled helper batches only eligible rollover work and preserves owner quote selection', () => {
    for (const changed of [{ timestamp: 200n }, { work: 1 }, { work: 1, cursor: 2n }])
      expect(planUpkeep({ ...state, ...changed }, memory, false, true)).toEqual({ action: 'rollover', actor: 'operator' })
    expect(planUpkeep(state, memory, true, true)).toEqual({ action: 'quote', actor: 'buyer' })
    expect(planUpkeep({ ...state, work: 2 }, memory, true, true)).toBeNull()
    expect(planUpkeep({ ...state, halted: true }, memory, true, true)).toBeNull()
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
  test('a batch journal preserves the expected snapshot and measurement and rejects missing or owner-mismatched batch metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eros-upkeep-batch-'))
    const path = join(directory, 'journal.json')
    try {
      const store = new UpkeepStore(path, binding)
      const journal = store.read()
      const rawTransaction = '0x0102' as Hex
      const pending = { market: 'demo' as const, action: 'rollover' as const, actor: 'operator' as const,
        hash: keccak256(rawTransaction), rawTransaction, data: '0x1234' as Hex, gasLimit: 1_210_000,
        estimate: '1000000', plannedBlock: '123', batch: { epoch: '2', work: 1 as const, cursor: '32', pages: 11, estimationMs: 40 } }
      journal.pending = pending
      store.write(journal); store.close()
      const resumed = new UpkeepStore(path, binding)
      expect(resumed.read().pending).toEqual(pending)
      for (const altered of [{ ...pending, batch: undefined }, { ...pending, actor: 'buyer' as const },
        { ...pending, batch: { ...pending.batch, pages: 33 } }, { ...pending, action: 'quote' as const }]) {
        const changed = resumed.read(); changed.pending = altered
        expect(() => resumed.write(changed)).toThrow()
      }
      resumed.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
