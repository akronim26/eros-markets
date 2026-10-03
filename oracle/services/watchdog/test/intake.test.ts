// Envio intake (O37.3 → O35.1): the watchdog reads proposals and assertions from the indexer up to its progress block,
// and the oracle's logs (100 blocks per call) when the indexer is down, erroring or too far behind; one cursor, so no
// block is read twice or skipped across a switch.
import { IndexerClient } from '@eros-oracle/oracle-sdk'
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { fromIndexer, IntakeReader } from '../src/chain'

const M = `0x${'ab'.repeat(32)}` as Hex
const A = `0x${'cd'.repeat(32)}` as Hex
const row = (block: number, logIndex: number, path = 3) => ({
  market_id: M.toUpperCase().replace('0X', '0x'), outcome: 1, path, evidenceHash: `0x${'11'.repeat(32)}`, evidenceURI: path === 1 ? null : 'eros-snapshot:0x11',
  valueHash: path === 1 ? `0x${'22'.repeat(32)}` : null, observedAt: path === 1 ? '1791000000' : null, attempt: 0, block, logIndex,
})

type Ix = { up: boolean; progress: number; calls: { from: number; to: number }[]; rows: ReturnType<typeof row>[] }
const indexer = (x: Ix) =>
  new IndexerClient('http://indexer/v1/graphql', 10143, (async (_u: string, init: RequestInit) => {
    if (!x.up) throw new TypeError('connect ECONNREFUSED')
    const { query, variables } = JSON.parse(init.body as string)
    if (query.includes('_meta')) return Response.json({ data: { _meta: [{ chainId: 10143, progressBlock: x.progress, sourceBlock: x.progress, isReady: true }] } })
    x.calls.push(variables)
    const inRange = (b: number) => b > variables.from && b <= variables.to
    return Response.json({ data: { Proposal: x.rows.filter((r) => inRange(r.block)), Assertion: x.rows.filter((r) => inRange(r.block)).map((r) => ({ id: A, market_id: r.market_id, assertedBlock: r.block, assertedLogIndex: r.logIndex + 1 })) } })
  }) as unknown as typeof fetch)

function logs() {
  const ranges: [bigint, bigint][] = []
  const fail = { at: undefined as bigint | undefined }
  const readLogs = async (from: bigint, to: bigint) => {
    if (fail.at === from) {
      fail.at = undefined
      throw new Error('rpc: 503')
    }
    ranges.push([from, to])
    return { proposals: [{ marketId: M, outcome: 2, path: 1, evidenceHash: `0x${'33'.repeat(32)}` as Hex, attempt: 0, block: to, logIndex: 0 }], asserted: [] }
  }
  return { ranges, readLogs, fail }
}

describe('watchdog intake from the indexer', () => {
  test('rows become the same Proposal shape the log path gives', () => {
    const out = fromIndexer({ Proposal: [row(10, 2, 1), row(11, 0)], Assertion: [{ id: A, market_id: M }] })
    expect(out.proposals).toEqual([
      { marketId: M, outcome: 1, path: 1, evidenceHash: `0x${'11'.repeat(32)}`, valueHash: `0x${'22'.repeat(32)}`, observedAt: 1791000000n, attempt: 0, block: 10n, logIndex: 2 },
      { marketId: M, outcome: 1, path: 3, evidenceHash: `0x${'11'.repeat(32)}`, evidenceURI: 'eros-snapshot:0x11', attempt: 0, block: 11n, logIndex: 0 },
    ])
    expect(out.asserted).toEqual([{ marketId: M, assertionId: A }])
  })

  test('reads up to the progress block only, then continues from there; no log is read', async () => {
    const head = { n: 1_000n }
    const x: Ix = { up: true, progress: 990, calls: [], rows: [row(995, 0), row(980, 1)] }
    const l = logs()
    const r = new IntakeReader({ start: 900n, head: async () => head.n, readLogs: l.readLogs, indexer: { client: indexer(x), maxLagBlocks: 300n } })
    expect((await r.events()).proposals.map((p) => p.block)).toEqual([980n])
    expect(x.calls).toEqual([{ from: 899, to: 990 }])
    x.progress = 1_000
    expect((await r.events()).proposals.map((p) => p.block)).toEqual([995n])
    expect(x.calls.at(-1)).toEqual({ from: 990, to: 1_000 })
    expect(await r.events()).toEqual({ proposals: [], asserted: [] }) // nothing new
    expect(l.ranges).toEqual([])
  })

  test('indexer down → the logs from the cursor, in 100-block calls; back up → the indexer from where the logs stopped', async () => {
    const head = { n: 1_000n }
    const x: Ix = { up: true, progress: 1_000, calls: [], rows: [] }
    const l = logs()
    const lines: string[] = []
    const r = new IntakeReader({ start: 900n, head: async () => head.n, readLogs: l.readLogs, indexer: { client: indexer(x), maxLagBlocks: 300n, log: (lv, m) => void lines.push(`${lv} ${m}`) } })
    await r.events()
    x.up = false
    head.n = 1_250n
    expect((await r.events()).proposals.map((p) => p.block)).toEqual([1_100n, 1_200n, 1_250n])
    expect(l.ranges).toEqual([[1_001n, 1_100n], [1_101n, 1_200n], [1_201n, 1_250n]])
    x.up = true
    x.progress = 1_300
    head.n = 1_300n
    await r.events()
    expect(x.calls.at(-1)).toEqual({ from: 1_250, to: 1_300 })
    expect(lines).toEqual(['info intake: reading the indexer', 'warn intake: indexer not usable, reading RPC logs', 'info intake: reading the indexer'])
  })

  test('an indexer too far behind is not used; a failed log range keeps what was read and resumes there', async () => {
    const head = { n: 1_500n }
    const x: Ix = { up: true, progress: 1_199, calls: [], rows: [] }
    const l = logs()
    l.fail.at = 1_400n
    const r = new IntakeReader({ start: 1_200n, head: async () => head.n, readLogs: l.readLogs, indexer: { client: indexer(x), maxLagBlocks: 300n } })
    expect((await r.events()).proposals.map((p) => p.block)).toEqual([1_299n, 1_399n]) // 301 behind: logs; 1,400 fails
    expect(r.cursor).toBe(1_400n)
    expect((await r.events()).proposals.map((p) => p.block)).toEqual([1_499n, 1_500n])
    expect(x.calls).toEqual([])
  })

  test('a long catch-up is read 10,000 blocks per query', async () => {
    const x: Ix = { up: true, progress: 25_000, calls: [], rows: [] }
    const r = new IntakeReader({ start: 1n, head: async () => 25_000n, readLogs: logs().readLogs, indexer: { client: indexer(x), maxLagBlocks: 300n } })
    for (let i = 0; i < 4; i++) await r.events()
    expect(x.calls).toEqual([{ from: 0, to: 10_000 }, { from: 10_000, to: 20_000 }, { from: 20_000, to: 25_000 }])
    expect(r.cursor).toBe(25_001n)
  })

  test('without an indexer it is the log scan alone', async () => {
    const l = logs()
    const r = new IntakeReader({ start: 1n, head: async () => 150n, readLogs: l.readLogs })
    await r.events()
    expect(l.ranges).toEqual([[1n, 100n], [101n, 150n]])
  })
})
