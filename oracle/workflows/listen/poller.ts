import type { Hex } from 'viem'

export type Request = {
  tx: Hex
  block: string
  logIndex: number
  market: Hex
  retryAt: number
}
export type Checkpoint = {
  version: 1
  chainId: number
  oracle: Hex
  broadcast: boolean
  target: string
  nextBlock: string
  anchor?: { number: string; hash: Hex }
  pending: Request[]
}

/** Monad's public RPC accepts at most 100 blocks, inclusive. */
export function nextRange(next: bigint, finalized: bigint): [bigint, bigint] | undefined {
  if (next > finalized) return undefined
  return [next, next + 99n < finalized ? next + 99n : finalized]
}

export function enqueue(state: Checkpoint, events: Request[], to: bigint, hash: Hex): Checkpoint {
  const pending = [...state.pending]
  const seen = new Set(pending.map(e => `${e.tx}:${e.logIndex}`))
  for (const event of events) {
    const key = `${event.tx}:${event.logIndex}`
    if (!seen.has(key)) { pending.push(event); seen.add(key) }
  }
  // Queue and cursor are persisted together: a crash cannot advance past an unqueued event.
  return { ...state, nextBlock: String(to + 1n), anchor: { number: String(to), hash }, pending }
}

/** CRE expects the receipt-local index, not the block-wide RPC logIndex. */
export function receiptIndex(logs: { logIndex: number | null }[], event: Request): number {
  const index = logs.findIndex(l => l.logIndex === event.logIndex)
  if (index < 0) throw new Error('ResolutionRequested log is missing from its receipt')
  return index
}

export function validateCheckpoint(value: unknown, scope: Pick<Checkpoint, 'chainId' | 'oracle' | 'broadcast' | 'target'>): Checkpoint {
  const s = value as Checkpoint
  const hex = (v: unknown, bytes: number) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)
  const decimal = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v)
  if (!s || s.version !== 1 || s.chainId !== scope.chainId || s.oracle?.toLowerCase() !== scope.oracle.toLowerCase()
    || s.broadcast !== scope.broadcast || s.target !== scope.target || !decimal(s.nextBlock) || !Array.isArray(s.pending)
    || (s.anchor && (!decimal(s.anchor.number) || !hex(s.anchor.hash, 32) || BigInt(s.anchor.number) + 1n !== BigInt(s.nextBlock)))
    || s.pending.some(e => !hex(e.tx, 32) || !hex(e.market, 32) || !decimal(e.block)
      || !Number.isSafeInteger(e.logIndex) || e.logIndex < 0 || !Number.isSafeInteger(e.retryAt) || e.retryAt < 0)) {
    throw new Error('Invalid checkpoint or chain/oracle/target/broadcast mismatch; use a separate state directory')
  }
  return s
}
