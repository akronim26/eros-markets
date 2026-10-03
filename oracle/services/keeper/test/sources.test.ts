// Task O31.1: market sources and the state version.
import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from 'viem'
import { IndexerSource, type LogClient, RegistryLogSource } from '../src/sources'
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

  test('pages through every Market id', async () => {
    const calls: unknown[] = []
    const src = new IndexerSource('http://indexer/v1/graphql', 2, fake([
      { data: { Market: [{ id: id(1) }, { id: id(2) }] } },
      { data: { Market: [{ id: id(3) }] } },
    ], calls))
    expect(await src.marketIds()).toEqual([id(1), id(2), id(3)])
    expect(calls).toEqual([{ limit: 2, offset: 0 }, { limit: 2, offset: 2 }])
  })

  test('an HTTP error, GraphQL errors or a malformed answer throw', async () => {
    await expect(new IndexerSource('u', 2, fake([new Response('x', { status: 502 })])).marketIds()).rejects.toThrow(/HTTP 502/)
    await expect(new IndexerSource('u', 2, fake([{ errors: [{ message: 'field "Market" not found' }] }])).marketIds()).rejects.toThrow(/not found/)
    await expect(new IndexerSource('u', 2, fake([{ data: {} }])).marketIds()).rejects.toThrow(/no Market list/)
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
        return [...listed].filter(([b]) => b >= fromBlock && b <= toBlock).map(([, i]) => ({ args: { id: i } }))
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
