// Exercise the actual viem adapter against an ephemeral loopback JSON-RPC fixture.
import { ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, type Hex, keccak256, stringToBytes } from 'viem'
import { viemCaseChain } from '../src/backend/chain'

const ORACLE = '0x0000000000000000000000000000000000000011'
const REGISTRY = '0x0000000000000000000000000000000000000012'
const ID = keccak256(stringToBytes('committee-chain-test'))
const OTHER_ID = keccak256(stringToBytes('committee-chain-test-other'))
const HASH = keccak256(stringToBytes('committee-chain-test-evidence'))
const TIMESTAMP = 1_800_000_000n
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex

function eventLog(name: 'StateChanged' | 'PanelResultAccepted', id: Hex, block: bigint) {
  const event = ResolutionOracleAbi.find((e) => e.type === 'event' && e.name === name)!
  if (event.type !== 'event') throw new Error(`Missing ${name} ABI`)
  const fields = event.inputs.filter((input) => !input.indexed)
  const values: Record<string, unknown> = name === 'StateChanged' ? { from: 4, to: 5 } : {
    phase: 2, labels: [1, 1, 1], calibratedBps: [9900, 9900, 9900],
    evidenceHash: HASH, evidenceURI: `eros-snapshot:${HASH}`, routedTo: 5,
  }
  return {
    address: ORACLE, blockNumber: hex(block), blockHash: HASH, transactionHash: HASH,
    transactionIndex: '0x0', logIndex: name === 'StateChanged' ? '0x0' : '0x1', removed: false,
    topics: encodeEventTopics({ abi: ResolutionOracleAbi, eventName: name, args: { id } }),
    data: encodeAbiParameters(fields, fields.map((input) => values[input.name]) as never),
  }
}

function fixture() {
  let head = 100n
  let logs: ReturnType<typeof eventLog>[] = []
  let beforeLogs: (from: bigint, to: bigint) => Promise<void> = async () => {}
  let failedFrom: bigint | undefined
  const ranges: [bigint, bigint][] = []
  const originalNow = Date.now
  let clock = originalNow()
  Date.now = () => clock
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { id: number; method: string; params: any[] }
    let result: unknown
    if (body.method === 'eth_blockNumber') result = hex(head)
    else if (body.method === 'eth_getLogs') {
      const from = BigInt(body.params[0].fromBlock), to = BigInt(body.params[0].toBlock)
      ranges.push([from, to])
      await beforeLogs(from, to)
      if (from === failedFrom) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'fixture page failed' } })
      result = logs.filter((log) => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to)
    } else if (body.method === 'eth_getBlockByNumber') {
      const block = BigInt(body.params[0])
      result = { number: hex(block), hash: HASH, timestamp: hex(TIMESTAMP + block), transactions: [] }
    } else return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unexpected fixture RPC method ${body.method}` } })
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  } })
  const chain = viemCaseChain({ rpcUrl: server.url.toString(), fromBlock: 100n, deployments: {
    network: 'monad-testnet', chainId: 10143, usdc: REGISTRY,
    contracts: { ResolutionOracle: { address: ORACLE, deployBlock: 100, codehash: HASH },
      MarketRegistry: { address: REGISTRY, deployBlock: 100, codehash: HASH } },
  } })
  return {
    chain, ranges,
    // Expire viem's head cache without a wall-clock wait.
    head(n: bigint) { head = n; clock += 5000 },
    logs(next: ReturnType<typeof eventLog>[]) { logs = next },
    beforeLogs(fn: typeof beforeLogs) { beforeLogs = fn },
    failFrom(n?: bigint) { failedFrom = n },
    close() { Date.now = originalNow; server.stop(true) },
  }
}

describe('committee chain event cache', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })
  afterEach(() => { f.close() })

  test('partial and unchanged heads preserve the next block and deliver evidence and entry time', async () => {
    expect(await f.chain.lastPanelResult(ID)).toBeNull()
    expect(await f.chain.markets()).toEqual([])
    expect(f.ranges).toEqual([[100n, 100n]])
    f.logs([eventLog('StateChanged', ID, 101n), eventLog('PanelResultAccepted', ID, 101n)])
    f.head(101n)
    expect(await f.chain.lastPanelResult(ID)).toEqual({
      phase: 2, labels: [1, 1, 1], calibratedBps: [9900, 9900, 9900],
      evidenceHash: HASH, evidenceURI: `eros-snapshot:${HASH}`, routedTo: 5, at: TIMESTAMP + 101n,
    })
    expect(await f.chain.enteredAt(ID, 5)).toBe(TIMESTAMP + 101n)
    expect(await f.chain.markets()).toEqual([ID])
    f.head(101n)
    expect(await f.chain.markets()).toEqual([ID])
    expect(f.ranges).toEqual([[100n, 100n], [101n, 101n]])
  })

  test('full pages and a final partial page advance by their actual endpoint', async () => {
    f.head(399n)
    await f.chain.markets()
    expect(f.ranges).toEqual([[100n, 199n], [200n, 299n], [300n, 399n]])
    f.logs([eventLog('StateChanged', ID, 400n)])
    f.head(400n)
    expect(await f.chain.enteredAt(ID, 5)).toBe(TIMESTAMP + 400n)
    f.head(501n)
    await f.chain.markets()
    expect(f.ranges).toEqual([[100n, 199n], [200n, 299n], [300n, 399n], [400n, 400n], [401n, 500n], [501n, 501n]])
  })

  test('concurrent evidence, entry time and market reads share one complete scan', async () => {
    f.head(399n)
    f.logs([eventLog('StateChanged', ID, 299n), eventLog('PanelResultAccepted', ID, 299n)])
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    f.beforeLogs(async (from) => { if (from === 100n) { entered(); await held } })
    const panel = f.chain.lastPanelResult(ID)
    await started
    const time = f.chain.enteredAt(ID, 5)
    const markets = f.chain.markets()
    release()
    expect(await panel).toMatchObject({ evidenceHash: HASH, at: TIMESTAMP + 299n })
    expect(await time).toBe(TIMESTAMP + 299n)
    expect(await markets).toEqual([ID])
    expect(f.ranges).toEqual([[100n, 199n], [200n, 299n], [300n, 399n]])
    f.logs([eventLog('StateChanged', OTHER_ID, 400n)])
    f.head(400n)
    expect(await f.chain.markets()).toEqual([ID, OTHER_ID])
    expect(f.ranges.at(-1)).toEqual([400n, 400n])
  })

  test('a later-page failure rejects all callers and retries without retaining a partial cache', async () => {
    f.head(201n)
    f.logs([eventLog('StateChanged', ID, 150n), eventLog('PanelResultAccepted', ID, 150n)])
    f.failFrom(200n)
    const reads = await Promise.allSettled([f.chain.lastPanelResult(ID), f.chain.enteredAt(ID, 5), f.chain.markets()])
    expect(reads.map((read) => read.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(f.ranges).toEqual([[100n, 199n], [200n, 201n]])
    f.ranges.length = 0
    f.failFrom()
    // The retry can see different latest-chain logs. Nothing from the failed scan was committed.
    f.logs([eventLog('StateChanged', OTHER_ID, 201n), eventLog('PanelResultAccepted', OTHER_ID, 201n)])
    expect(await f.chain.markets()).toEqual([OTHER_ID])
    expect(await f.chain.lastPanelResult(ID)).toBeNull()
    expect(await f.chain.enteredAt(ID, 5)).toBeNull()
    expect(await f.chain.lastPanelResult(OTHER_ID)).toMatchObject({ evidenceHash: HASH, at: TIMESTAMP + 201n })
    expect(await f.chain.enteredAt(OTHER_ID, 5)).toBe(TIMESTAMP + 201n)
    expect(f.ranges).toEqual([[100n, 199n], [200n, 201n]])
  })
})
