// Task O31.1: the Chain the keeper uses, over viem (plan §9): reads at `latest`, eth_call before sending, an
// explicit gas limit on every transaction, and no waiting on receipts (Monad executes asynchronously; the next
// tick re-reads instead).
import {
  BondTreasuryAbi,
  contractAddress,
  type Deployments,
  IAssertionVenueAbi,
  KeeperRouterAbi,
  MarketRegistryAbi,
  ResolutionEngineStubAbi,
  ResolutionOracleAbi,
} from '@eros-oracle/oracle-sdk'
import {
  type Abi,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  TransactionReceiptNotFoundError,
} from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import { engineFollowUpAbi } from './engineAbi'
import type { Chain, Job, Resolution, Target } from './types'

const ABIS: Record<Target, Abi> = {
  ResolutionOracle: ResolutionOracleAbi as Abi,
  KeeperRouter: KeeperRouterAbi as Abi,
  BondTreasury: BondTreasuryAbi as Abi,
  Engine: engineFollowUpAbi as Abi,
}

function engineAddress(job: Job): Hex {
  if (!job.address) throw new Error(`${job.action}: an engine job needs the engine's address`)
  return job.address
}

export function viemChain(opts: { rpcUrl: string; privateKey: Hex; deployments: Deployments }): Chain {
  const d = opts.deployments
  const chain = defineChain({
    id: d.chainId,
    name: d.network,
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  })
  const transport = http(opts.rpcUrl)
  const account = privateKeyToAccount(opts.privateKey, { nonceManager }) // back-to-back sends without waiting
  const pc = createPublicClient({ chain, transport })
  const wc = createWalletClient({ chain, transport, account })
  const oracle = contractAddress(d, 'ResolutionOracle')
  const registry = contractAddress(d, 'MarketRegistry')
  const treasury = contractAddress(d, 'BondTreasury')
  const call = (job: Job) => ({
    address: job.target === 'Engine' ? engineAddress(job) : contractAddress(d, job.target),
    abi: ABIS[job.target],
    functionName: job.functionName,
    args: job.args as unknown[],
  })

  return {
    async now() {
      return (await pc.getBlock({ blockTag: 'latest' })).timestamp
    },
    async getResolution(id) {
      return (await pc.readContract({
        address: oracle,
        abi: ResolutionOracleAbi,
        functionName: 'getResolution',
        args: [id],
        blockTag: 'latest',
      })) as Resolution
    },
    async marketInfo(id) {
      const c = await pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [id], blockTag: 'latest' })
      const f = c.hasFeed
        ? await pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'getFeedSpec', args: [id], blockTag: 'latest' })
        : undefined
      return {
        tau: c.tau,
        hasFeed: c.hasFeed,
        bufferSecs: BigInt(f?.bufferSecs ?? 0),
        l1TimeoutSecs: BigInt(f?.l1TimeoutSecs ?? 0),
        l2DeadlineSecs: BigInt(c.l2DeadlineSecs),
        earlyTtlSecs: BigInt(c.earlyTtlSecs),
        engine: c.engine,
      }
    },
    async globalsMinRequestIntervalSecs(version) {
      const v = version !== 0
        ? version
        : await pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'globalsVersion', blockTag: 'latest' })
      const g = await pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: 'globalsAt', args: [v], blockTag: 'latest' })
      return BigInt(g.minRequestIntervalSecs)
    },
    async assertionStatus(venue, assertionId) {
      const st = await pc.readContract({ address: venue, abi: IAssertionVenueAbi, functionName: 'statusOf', args: [assertionId], blockTag: 'latest' })
      return { exists: st.exists, disputed: st.disputed, settled: st.settled, truthful: st.truthful, expiresAt: st.expiresAt }
    },
    async assertionLedger() {
      return pc.readContract({ address: treasury, abi: BondTreasuryAbi, functionName: 'balanceOf', args: [0], blockTag: 'latest' }) // Ledger.ASSERTION
    },
    async bondFor(id) {
      return pc.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'bondFor', args: [id], blockTag: 'latest' })
    },
    async settlementStatus(engine) {
      const v = await pc.readContract({ address: engine, abi: ResolutionEngineStubAbi, functionName: 'getSettlementStatus', blockTag: 'latest' })
      return {
        halted: v.halted,
        finalOutcome: v.finalOutcome,
        invalidPriceReady: v.invalidPriceReady,
        snapshotCursor: v.snapshotCursor,
        payoutCursor: v.payoutCursor,
        accountCount: v.accountCount,
        claimsEnabled: v.claimsEnabled,
        accountingComplete: v.accountingComplete,
        recoveryRequired: v.recoveryRequired,
      }
    },
    async treasuryDispute(assertionId) {
      const [marketId, venue, bond] = await pc.readContract({ address: treasury, abi: BondTreasuryAbi, functionName: 'disputes', args: [assertionId], blockTag: 'latest' })
      return { marketId, venue, bond }
    },
    async treasuryState() {
      const read = <F extends 'totalCommitted' | 'openDisputes'>(functionName: F) =>
        pc.readContract({ address: treasury, abi: BondTreasuryAbi, functionName, blockTag: 'latest' })
      const ledger = (l: number) => pc.readContract({ address: treasury, abi: BondTreasuryAbi, functionName: 'balanceOf', args: [l], blockTag: 'latest' })
      const [usdcBalance, assertionLedger, watchdogFloat, totalCommitted, openDisputes] = await Promise.all([
        pc.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [treasury], blockTag: 'latest' }),
        ledger(0), // Ledger.ASSERTION
        ledger(1), // Ledger.WATCHDOG_FLOAT
        read('totalCommitted'),
        read('openDisputes'),
      ])
      return { usdcBalance, assertionLedger, watchdogFloat, totalCommitted: totalCommitted as bigint, openDisputes: Number(openDisputes) }
    },
    async simulate(job) {
      const { result } = await pc.simulateContract({ ...call(job), account, blockTag: 'latest' })
      return result
    },
    async send(job, gas) {
      return wc.writeContract({ ...call(job), gas, account, chain })
    },
    async receiptStatus(hash) {
      try {
        return (await pc.getTransactionReceipt({ hash })).status
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return 'pending'
        throw e
      }
    },
  }
}
