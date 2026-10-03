// Task O35.1: the watchdog's WatchdogChain over viem, on its own RPC endpoint (plan §9.2). Reads at `latest`; the
// oracle's ProposedL1, ProposalRecorded and Asserted logs in 100-block steps (Monad's public RPC caps log ranges);
// disputeViaVenue and watchdogHeartbeat are eth_called / sent from the watchdog key with explicit gas limits.
import { BondTreasuryAbi, contractAddress, type Deployments, IAssertionVenueAbi, MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { type Address, createNonceManager, createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { jsonRpc } from 'viem/nonce'
import type { Proposal, WatchdogChain } from './types'

const STEP = 100n
const LEDGER_WATCHDOG_FLOAT = 1
const event = (name: string) => ResolutionOracleAbi.find((x) => x.type === 'event' && x.name === name)!

export function viemWatchdogChain(opts: { rpcUrl: string; watchdogKey: Hex; deployments: Deployments; fromBlock?: bigint }): WatchdogChain {
  const d = opts.deployments
  const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
  const pc = createPublicClient({ chain, transport: http(opts.rpcUrl) })
  // its own nonce manager (not viem's shared one): heartbeats and disputes go out without waiting for receipts
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
  let next = opts.fromBlock ?? BigInt(d.contracts.ResolutionOracle.deployBlock)

  return {
    address: account.address,
    async now() {
      return (await pc.getBlock({ blockTag: 'latest' })).timestamp
    },
    async events() {
      const head = await pc.getBlockNumber()
      const proposals: Proposal[] = []
      const asserted: { marketId: Hex; assertionId: Hex }[] = []
      for (; next <= head; next += STEP) {
        const to = next + STEP - 1n < head ? next + STEP - 1n : head
        const logs = (await pc.getLogs({ address: oracle, events: [event('ProposedL1'), event('ProposalRecorded'), event('Asserted')] as never, fromBlock: next, toBlock: to })) as any[]
        for (const l of logs) {
          const id = (l.args.id as Hex).toLowerCase() as Hex
          const at = { block: l.blockNumber as bigint, logIndex: l.logIndex as number }
          if (l.eventName === 'Asserted') asserted.push({ marketId: id, assertionId: l.args.assertionId })
          else if (l.eventName === 'ProposalRecorded')
            proposals.push({ marketId: id, outcome: Number(l.args.outcome), path: Number(l.args.path), evidenceHash: l.args.evidenceHash, evidenceURI: l.args.evidenceURI, attempt: Number(l.args.attempt), ...at })
          else {
            // ProposedL1 carries no attempt: the market's attempts now (an L1 proposal is the market's first, attempt 0)
            const r = await ro('getResolution', [id])
            proposals.push({ marketId: id, outcome: Number(l.args.outcome), path: 1, evidenceHash: l.args.evidenceHash, valueHash: l.args.valueHash, observedAt: BigInt(l.args.observedAt), attempt: Number(r.attempts), ...at })
          }
        }
      }
      return { proposals, asserted }
    },
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
