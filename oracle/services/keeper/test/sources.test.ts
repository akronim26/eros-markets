import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from 'viem'
import { IndexerClient } from '@eros-oracle/oracle-sdk'
import { indexedDisputes, indexedMarkets, IndexerDisputeSource, IndexerSource, type LogClient, RegistryLogSource, TreasuryDisputeSource } from '../src/sources'
import { stateVersion } from '../src/version'
import { id, resolution } from './fake'

describe('stateVersion', () => {
  test('is keccak256 of the Resolution tuple, encoded independently here', () => {
    const r = resolution({ requestCount: 3, bond: 222400000n, assertionId: id(9) })
    const types = parseAbiParameters(
      '(uint8,uint8,uint8,uint8,uint8,uint8,uint8,bool,uint64,uint64,uint64,uint64,uint64,uint64,uint32,uint32,uint32,uint256,bytes32,bytes32,bytes32,address,uint256,address,uint256)',
    )
    const tuple = [r.state, r.proposed, r.path, r.attempts, r.rejectedMask, r.outcome, r.finalReason, r.voided, r.haltedAt,
      r.voidDeadline, r.l2StartedAt, r.retryOpensAt, r.earlyStartedAt, r.lastRequestAt, r.requestCount, r.trustSetId,
      r.globalsVersion, r.oiHaltLots, r.evidenceHash, r.valueHash, r.assertionId, r.assertionVenue, r.bond, r.proposer,
      r.rewardAtoms] as const
    expect(stateVersion(r)).toBe(keccak256(encodeAbiParameters(types, [tuple as never])))
  })

  test('changes with every field and not otherwise', () => {
    const base = resolution()
    expect(stateVersion(resolution())).toBe(stateVersion(base))
    const edits: Record<string, unknown> = {
      state: 4, proposed: 1, path: 1, attempts: 1, rejectedMask: 2, outcome: 1, finalReason: 1, voided: true, haltedAt: 1001n,
      voidDeadline: 2001n, l2StartedAt: 1n, retryOpensAt: 1n, earlyStartedAt: 1n, lastRequestAt: 1n, requestCount: 1,
      trustSetId: 2, globalsVersion: 2, oiHaltLots: 1n, evidenceHash: id(1), valueHash: id(2), assertionId: id(3),
      assertionVenue: '0x00000000000000000000000000000000000000aa', bond: 1n, proposer: '0x00000000000000000000000000000000000000bb',
      rewardAtoms: 1n,
    }
    expect(Object.keys(edits).sort()).toEqual(Object.keys(base).sort())
    const seen = new Set([stateVersion(base)])
    for (const [k, v] of Object.entries(edits)) {
      const ver = stateVersion({ ...base, [k]: v })
      expect(seen.has(ver), k).toBe(false)
      seen.add(ver)
    }
  })
})

describe('IndexerSource', () => {
  const fake = (pages: unknown[], calls: unknown[] = []): typeof fetch =>
    (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string).variables)
      const body = pages.shift()
      if (body instanceof Response) return body
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

  test('pages through every Market id until an empty page', async () => {
    const calls: unknown[] = []
    const src = new IndexerSource(new IndexerClient('http://indexer/v1/graphql', 10143, fake([
      { data: { Market: [{ id: id(1) }, { id: id(2) }] } },
      { data: { Market: [{ id: id(3) }] } },
      { data: { Market: [] } },
    ], calls)), 2)
    expect(await src.marketIds()).toEqual([id(1), id(2), id(3)])
    expect(calls).toEqual([{ limit: 2, offset: 0 }, { limit: 2, offset: 2 }, { limit: 2, offset: 3 }])
  })

  test('a server capping rows below the page size does not end the list early', async () => {
    const calls: unknown[] = []
    const src = new IndexerSource(new IndexerClient('u', 10143, fake([
      { data: { Market: [{ id: id(1) }] } }, // asked for 1000, the server returns 1
      { data: { Market: [{ id: id(2) }] } },
      { data: { Market: [] } },
    ], calls)))
    expect(await src.marketIds()).toEqual([id(1), id(2)])
    expect(calls).toEqual([{ limit: 1000, offset: 0 }, { limit: 1000, offset: 1 }, { limit: 1000, offset: 2 }])
  })

  test('an HTTP error, GraphQL errors or a malformed answer throw', async () => {
    const src = (pages: unknown[]) => new IndexerSource(new IndexerClient('u', 10143, fake(pages)), 2)
    await expect(src([new Response('x', { status: 502 })]).marketIds()).rejects.toThrow(/HTTP 502/)
    await expect(src([{ errors: [{ message: 'field "Market" not found' }] }]).marketIds()).rejects.toThrow(/not found/)
    await expect(src([{ data: {} }]).marketIds()).rejects.toThrow(/no Market list/)
  })

  test('treasury disputes: the Dispute rows funded by the float', async () => {
    const calls: unknown[] = []
    const src = new IndexerDisputeSource(new IndexerClient('u', 10143, fake([{ data: { Dispute: [{ id: id(7) }] } }, { data: { Dispute: [] } }], calls)), 5)
    expect(await src.assertionIds()).toEqual([id(7)])
    expect(calls).toEqual([{ limit: 5, offset: 0 }, { limit: 5, offset: 1 }])
  })
})

describe('RegistryLogSource', () => {
  const REGISTRY = '0x00000000000000000000000000000000000000CC'
  function client(head: { n: bigint }, listed: Map<bigint, Hex>, fail: { at?: bigint } = {}) {
    const ranges: [bigint, bigint][] = []
    const c: LogClient = {
      getBlockNumber: async () => head.n,
      getLogs: async ({ fromBlock, toBlock, address }) => {
        expect(address).toBe(REGISTRY)
        if (fail.at !== undefined && fromBlock === fail.at) {
          fail.at = undefined
          throw new Error('rpc: range too large')
        }
        ranges.push([fromBlock, toBlock])
        return [...listed].filter(([b]) => b >= fromBlock && b <= toBlock).map(([, i]) => ({ args: { id: i } as Record<string, unknown> }))
      },
    }
    return { c, ranges }
  }

  test('scans from the deploy block in 100-block ranges, then only the new blocks', async () => {
    const head = { n: 1250n }
    const listed = new Map<bigint, Hex>([[1000n, id(1)], [1099n, id(2)], [1250n, id(3)]])
    const { c, ranges } = client(head, listed)
    const src = new RegistryLogSource(c, REGISTRY, 1000n)
    expect(await src.marketIds()).toEqual([id(1), id(2), id(3)])
    expect(ranges).toEqual([[1000n, 1099n], [1100n, 1199n], [1200n, 1250n]])
    for (const [a, b] of ranges) expect(b - a + 1n <= 100n).toBe(true)
    head.n = 1300n
    listed.set(1290n, id(4))
    expect(await src.marketIds()).toEqual([id(1), id(2), id(3), id(4)])
    expect(ranges.slice(3)).toEqual([[1251n, 1300n]])
  })

  test('a failed range is read again from the same block', async () => {
    const head = { n: 1150n }
    const listed = new Map<bigint, Hex>([[1120n, id(1)]])
    const fail = { at: 1100n as bigint | undefined }
    const { c, ranges } = client(head, listed, fail)
    const src = new RegistryLogSource(c, REGISTRY, 1000n)
    await expect(src.marketIds()).rejects.toThrow(/range too large/)
    expect(await src.marketIds()).toEqual([id(1)])
    expect(ranges).toEqual([[1000n, 1099n], [1100n, 1150n]])
  })
})

describe('the indexer first, RPC logs as the fallback', () => {
  const REGISTRY = '0x00000000000000000000000000000000000000CC'
  const TREASURY = '0x00000000000000000000000000000000000000DD'
  type Mode = { up: boolean; progress: number; markets: Hex[]; disputes: Hex[]; marketsFail?: boolean }
  const indexer = (m: Mode) =>
    new IndexerClient('http://indexer/v1/graphql', 10143, (async (_u: string, init: RequestInit) => {
      if (!m.up) throw new TypeError('connect ECONNREFUSED')
      const { query: q, variables } = JSON.parse(init.body as string) as { query: string; variables: { offset?: number } }
      if (q.includes('_meta')) return Response.json({ data: { _meta: [{ chainId: 10143, progressBlock: m.progress, sourceBlock: m.progress, isReady: true }] } })
      if (q.includes('Dispute(')) return Response.json({ data: { Dispute: m.disputes.slice(variables.offset).map((x) => ({ id: x })) } })
      if (m.marketsFail) return Response.json({ errors: [{ message: 'database is starting' }] })
      return Response.json({ data: { Market: m.markets.slice(variables.offset).map((x) => ({ id: x })) } })
    }) as unknown as typeof fetch)
  function chainLogs(head: { n: bigint }, listed: Map<bigint, Hex>, disputed: Map<bigint, Hex>) {
    const ranges: [string, bigint, bigint][] = []
    const c: LogClient = {
      getBlockNumber: async () => head.n,
      getLogs: async ({ fromBlock, toBlock, address }) => {
        ranges.push([address, fromBlock, toBlock])
        const src = address === REGISTRY ? listed : disputed
        return [...src].filter(([b]) => b >= fromBlock && b <= toBlock).map(([, i]) => ({ args: address === REGISTRY ? { id: i } : { assertionId: i } }))
      },
    }
    return { c, ranges }
  }
  const logger = () => {
    const lines: string[] = []
    return { lines, log: { info: (m: string) => void lines.push(`info ${m}`), warn: (m: string) => void lines.push(`warn ${m}`), error: (m: string) => void lines.push(`error ${m}`) } }
  }

  test('a fresh indexer is used and no log is read; its progress moves the log cursor', async () => {
    const head = { n: 5_000n }
    const m: Mode = { up: true, progress: 4_990, markets: [id(1), id(2)], disputes: [id(9)] }
    const { c, ranges } = chainLogs(head, new Map([[1_500n, id(1)], [4_000n, id(2)], [4_995n, id(3)]]), new Map([[4_996n, id(8)]]))
    const { lines, log } = logger()
    const markets = indexedMarkets(indexer(m), new RegistryLogSource(c, REGISTRY, 1_000n), c.getBlockNumber, 300n, log)
    const disputes = indexedDisputes(indexer(m), new TreasuryDisputeSource(c, TREASURY, 1_000n), c.getBlockNumber, 300n, log)
    expect(await markets.marketIds()).toEqual([id(1), id(2)])
    expect(await disputes.assertionIds()).toEqual([id(9)])
    expect(ranges).toEqual([])
    // the indexer goes down: only the blocks after its progress (4,990) are scanned, and its ids are kept
    m.up = false
    expect(await markets.marketIds()).toEqual([id(1), id(2), id(3)])
    expect(await disputes.assertionIds()).toEqual([id(9), id(8)])
    expect(ranges).toEqual([[REGISTRY, 4_991n, 5_000n], [TREASURY, 4_991n, 5_000n]])
    expect(lines).toEqual(['info markets: reading the indexer', 'info treasury disputes: reading the indexer', 'warn markets: indexer not usable, reading RPC logs', 'warn treasury disputes: indexer not usable, reading RPC logs'])
    // back up: the indexer again, logged once
    m.up = true
    m.progress = 5_000
    m.markets = [id(1), id(2), id(3)]
    expect(await markets.marketIds()).toEqual([id(1), id(2), id(3)])
    expect(lines.at(-1)).toBe('info markets: reading the indexer')
  })

  test('an indexer more than the allowed lag behind the head is not used', async () => {
    const head = { n: 5_000n }
    const m: Mode = { up: true, progress: 4_699, markets: [id(1)], disputes: [] }
    const { c, ranges } = chainLogs(head, new Map([[1_000n, id(1)], [4_800n, id(2)]]), new Map())
    const { lines, log } = logger()
    const markets = indexedMarkets(indexer(m), new RegistryLogSource(c, REGISTRY, 1_000n), c.getBlockNumber, 300n, log)
    expect(await markets.marketIds()).toEqual([id(1), id(2)]) // 301 blocks behind: the logs, from the deploy block
    expect(ranges[0]).toEqual([REGISTRY, 1_000n, 1_099n])
    expect(lines).toEqual(['warn markets: indexer not usable, reading RPC logs'])
    m.progress = 4_700 // exactly 300 behind: usable
    expect(await markets.marketIds()).toEqual([id(1)])
  })

  test('an indexer that answers _meta but fails the list query falls back too', async () => {
    const head = { n: 2_000n }
    const m: Mode = { up: true, progress: 2_000, markets: [], disputes: [], marketsFail: true }
    const { c } = chainLogs(head, new Map([[1_200n, id(4)]]), new Map())
    const markets = indexedMarkets(indexer(m), new RegistryLogSource(c, REGISTRY, 1_000n), c.getBlockNumber, 300n)
    expect(await markets.marketIds()).toEqual([id(4)])
  })
})
