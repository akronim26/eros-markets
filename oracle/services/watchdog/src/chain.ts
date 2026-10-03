// The watchdog's chain over viem. Reads at `latest`; sends are eth_called first and carry explicit gas limits.
// Intake comes from the Envio indexer up to its progress block, or from the oracle's logs in 100-block steps when the
// indexer is unset, down or behind. One shared cursor means every block is read exactly once.
import {
  BondTreasuryAbi,
  contractAddress,
  type Deployments,
  freshProgress,
  IAssertionVenueAbi,
  type IndexerClient,
  MarketRegistryAbi,
  ResolutionOracleAbi,
  WATCHDOG_EVENTS,
  WATCHDOG_RANGE_BLOCKS,
} from '@eros-oracle/oracle-sdk'
import { type Address, createNonceManager, createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { jsonRpc } from 'viem/nonce'
import type { Proposal, WatchdogChain } from './types'

export const LOG_STEP = 100n
const LEDGER_WATCHDOG_FLOAT = 1
const event = (name: string) => ResolutionOracleAbi.find((x) => x.type === 'event' && x.name === name)!

type IndexedProposal = {
  market_id: string
  outcome: number
  path: number
  evidenceHash: string
  evidenceURI: string | null
  valueHash: string | null
  observedAt: string | null
  attempt: number
  block: number
  logIndex: number
}
type IndexedAssertion = { id: string; market_id: string }
type Events = Awaited<ReturnType<WatchdogChain['events']>>

/** Maps indexer rows to the same fields the log path gives. */
export function fromIndexer(rows: { Proposal: IndexedProposal[]; Assertion: IndexedAssertion[] }): Events {
  return {
    proposals: rows.Proposal.map((p) => {
      const base = { marketId: p.market_id.toLowerCase() as Hex, outcome: p.outcome, path: p.path, evidenceHash: p.evidenceHash as Hex, attempt: p.attempt, block: BigInt(p.block), logIndex: p.logIndex }
      return p.path === 1
        ? { ...base, valueHash: p.valueHash as Hex, observedAt: BigInt(p.observedAt ?? 0) }
        : { ...base, evidenceURI: p.evidenceURI ?? '' }
    }),
    asserted: rows.Assertion.map((a) => ({ marketId: a.market_id.toLowerCase() as Hex, assertionId: a.id as Hex })),
  }
}

/**
 * Returns the events of blocks not yet read: from the indexer up to its progress when fresh, else from the logs up to
 * the head. A failed read leaves the cursor in place, so the range is read again.
 */
export class IntakeReader {
  private next: bigint
  private usingIndexer: boolean | null = null

  constructor(
    private readonly o: { start: bigint; head: () => Promise<bigint>; readLogs: (from: bigint, to: bigint) => Promise<Events>; indexer?: WatchdogIndexer },
  ) {
    this.next = o.start
  }

  get cursor() {
    return this.next
  }

  async events(): Promise<Events> {
    const head = await this.o.head()
    const idx = this.o.indexer
    if (idx) {
      const fresh = await freshProgress(idx.client, head, idx.maxLagBlocks)
      if (fresh.ok) {
        const progress = BigInt(fresh.progress.progressBlock)
        const upTo = progress < head ? progress : head
        const to = upTo < this.next + WATCHDOG_RANGE_BLOCKS - 1n ? upTo : this.next + WATCHDOG_RANGE_BLOCKS - 1n // rest next tick
        if (to < this.next) return { proposals: [], asserted: [] }
        try {
          const out = fromIndexer(await idx.client.query(WATCHDOG_EVENTS, { from: Number(this.next) - 1, to: Number(to) }))
          this.next = to + 1n
          if (this.usingIndexer !== true) idx.log?.('info', 'intake: reading the indexer', { progressBlock: fresh.progress.progressBlock })
          this.usingIndexer = true
          return out
        } catch (e) {
          this.fallback(e instanceof Error ? e.message : String(e))
        }
      } else this.fallback(fresh.reason)
    }
    // The cursor moves past each range read, so a failure resumes there.
    const out: Events = { proposals: [], asserted: [] }
    while (this.next <= head) {
      const to = this.next + LOG_STEP - 1n < head ? this.next + LOG_STEP - 1n : head
      let r: Events
      try {
        r = await this.o.readLogs(this.next, to)
      } catch (e) {
        if (out.proposals.length || out.asserted.length) return out // the failed range is retried next tick
        throw e
      }
      out.proposals.push(...r.proposals)
      out.asserted.push(...r.asserted)
      this.next = to + 1n
    }
    return out
  }

  private fallback(reason: string) {
    if (this.usingIndexer !== false) this.o.indexer?.log?.('warn', 'intake: indexer not usable, reading RPC logs', { reason })
    this.usingIndexer = false
  }
}

export type WatchdogIndexer = { client: IndexerClient; maxLagBlocks: bigint; log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void }

export function viemWatchdogChain(opts: { rpcUrl: string; watchdogKey: Hex; deployments: Deployments; fromBlock?: bigint; indexer?: WatchdogIndexer }): WatchdogChain {
  const d = opts.deployments
  const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
  const pc = createPublicClient({ chain, transport: http(opts.rpcUrl) })
  // Own nonce manager: heartbeats and disputes go out without waiting for receipts.
  const account = privateKeyToAccount(opts.watchdogKey, { nonceManager: createNonceManager({ source: jsonRpc() }) })
  const wc = createWalletClient({ chain, transport: http(opts.rpcUrl), account })
  const oracle = contractAddress(d, 'ResolutionOracle')
  const registry = contractAddress(d, 'MarketRegistry')
  const treasury = contractAddress(d, 'BondTreasury')
  const ro = (functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>
  const reg = (functionName: string, args: readonly unknown[]) =>
    pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>
  const tr = (functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address: treasury, abi: BondTreasuryAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>
  /** One getLogs call over [from, to], at most LOG_STEP blocks. */
  async function readLogs(from: bigint, to: bigint): Promise<Events> {
    const proposals: Proposal[] = []
    const asserted: { marketId: Hex; assertionId: Hex }[] = []
    {
      const logs = (await pc.getLogs({ address: oracle, events: [event('ProposedL1'), event('ProposalRecorded'), event('Asserted')] as never, fromBlock: from, toBlock: to })) as any[]
      for (const l of logs) {
        const id = (l.args.id as Hex).toLowerCase() as Hex
        const at = { block: l.blockNumber as bigint, logIndex: l.logIndex as number }
        if (l.eventName === 'Asserted') asserted.push({ marketId: id, assertionId: l.args.assertionId })
        else if (l.eventName === 'ProposalRecorded')
          proposals.push({ marketId: id, outcome: Number(l.args.outcome), path: Number(l.args.path), evidenceHash: l.args.evidenceHash, evidenceURI: l.args.evidenceURI, attempt: Number(l.args.attempt), ...at })
        else {
          // ProposedL1 carries no attempt; an L1 proposal is always the market's first.
          const r = await ro('getResolution', [id])
          proposals.push({ marketId: id, outcome: Number(l.args.outcome), path: 1, evidenceHash: l.args.evidenceHash, valueHash: l.args.valueHash, observedAt: BigInt(l.args.observedAt), attempt: Number(r.attempts), ...at })
        }
      }
    }
    return { proposals, asserted }
  }
  const intake = new IntakeReader({ start: opts.fromBlock ?? BigInt(d.contracts.ResolutionOracle.deployBlock), head: () => pc.getBlockNumber(), readLogs, indexer: opts.indexer })

  return {
    address: account.address,
    async now() {
      return (await pc.getBlock({ blockTag: 'latest' })).timestamp
    },
    events: () => intake.events(),
    async resolution(id) {
      const r = await ro('getResolution', [id])
      return { state: Number(r.state), proposed: Number(r.proposed), path: Number(r.path), attempts: Number(r.attempts), assertionId: r.assertionId, assertionVenue: r.assertionVenue, bond: BigInt(r.bond), evidenceHash: r.evidenceHash }
    },
    async market(id) {
      const [question, rules, c] = await Promise.all([reg('getQuestion', [id]), reg('getRules', [id]), reg('getMarketCore', [id])])
      return { question, rules, tau: BigInt(c.tau), hasFeed: c.hasFeed }
    },
    async feedSpec(id) {
      const f = await reg('getFeedSpec', [id])
      return { ...f, valueType: Number(f.valueType), op: Number(f.op), decimals: Number(f.decimals), bufferSecs: Number(f.bufferSecs), l1TimeoutSecs: Number(f.l1TimeoutSecs) }
    },
    async allowList(id) {
      return reg('getAllowList', [id])
    },
    async assertion(venue: Address, assertionId: Hex) {
      const s = (await pc.readContract({ address: venue, abi: IAssertionVenueAbi, functionName: 'statusOf', args: [assertionId], blockTag: 'latest' })) as any
      return { exists: s.exists, settled: s.settled, disputed: s.disputed, expiresAt: BigInt(s.expiresAt), bond: BigInt(s.bond) }
    },
    async watchdogOf(id) {
      return ro('watchdogOf', [id])
    },
    async floatBalance() {
      return BigInt(await tr('balanceOf', [LEDGER_WATCHDOG_FLOAT]))
    },
    async openDisputes() {
      const [open, max] = await Promise.all([tr('openDisputes'), tr('maxOpenDisputes')])
      return { open: Number(open), max: Number(max) }
    },
    async lastHeartbeat() {
      return BigInt(await ro('lastHeartbeat', [account.address]))
    },
    async simulateDispute(id) {
      await pc.simulateContract({ address: treasury, abi: BondTreasuryAbi, functionName: 'disputeViaVenue', args: [id], account, blockTag: 'latest' })
    },
    async dispute(id, gas) {
      return wc.writeContract({ address: treasury, abi: BondTreasuryAbi, functionName: 'disputeViaVenue', args: [id], gas, account, chain })
    },
    async heartbeat(gas) {
      return wc.writeContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'watchdogHeartbeat', args: [], gas, account, chain })
    },
  }
}
