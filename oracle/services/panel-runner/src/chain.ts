// The runner's chain over viem. StateChanged logs are read in 100-block steps (Monad's RPC cap); submitPanelResult is
// eth_called, then sent with an explicit gas limit. Completion is reconciled against finalized receipts.
import { contractAddress, type ServiceDeployment, MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { buildUrl } from '@eros-oracle/feedspec'
import { createPublicClient, createWalletClient, defineChain, type Hex, http, TransactionReceiptNotFoundError } from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import type { PanelChain } from './runner'
import { stateChangeReader } from './state-changes'
import { panelReceiptStatus } from './receipt'

const STATE_CHANGED = ResolutionOracleAbi.find((x) => x.type === 'event' && x.name === 'StateChanged')!

export function viemPanelChain(opts: { rpcUrl: string; relayerKey: Hex; deployments: ServiceDeployment; fromBlock?: bigint }): PanelChain {
  const d = opts.deployments
  const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
  const pc = createPublicClient({ chain, transport: http(opts.rpcUrl) })
  const account = privateKeyToAccount(opts.relayerKey, { nonceManager })
  const wc = createWalletClient({ chain, transport: http(opts.rpcUrl), account })
  const oracle = contractAddress(d, 'ResolutionOracle')
  const registry = contractAddress(d, 'MarketRegistry')
  const stateChanges = stateChangeReader(opts.fromBlock ?? BigInt(d.contracts.ResolutionOracle.deployBlock),
    async () => (await pc.getBlock({ blockTag: 'finalized' })).number,
    async (fromBlock, toBlock) => {
      const logs = await pc.getLogs({ address: oracle, event: STATE_CHANGED as never, fromBlock, toBlock })
      return (logs as unknown as { args: { id: Hex; to: number } }[]).map(l => ({ id: l.args.id, to: Number(l.args.to) }))
    })
  const reg = <F extends string>(functionName: F, args: readonly unknown[]) =>
    pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>
  const ro = <F extends string>(functionName: F, args: readonly unknown[] = []) =>
    pc.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>

  return {
    chainId: d.chainId,
    oracle,
    async now() {
      return (await pc.getBlock({ blockTag: 'latest' })).timestamp
    },
    stateChanges,
    async market(id) {
      const [r, c] = await Promise.all([ro('getResolution', [id]), reg('getMarketCore', [id])])
      return {
        state: Number(r.state),
        attempts: Number(r.attempts),
        trustSetId: Number(r.trustSetId),
        l2StartedAt: BigInt(r.l2StartedAt),
        earlyStartedAt: BigInt(r.earlyStartedAt),
        tau: BigInt(c.tau),
        hasFeed: c.hasFeed,
        gateHash: c.gateHash,
        l2DeadlineSecs: BigInt(c.l2DeadlineSecs),
        earlyTtlSecs: BigInt(c.earlyTtlSecs),
      }
    },
    async aiConfig(id) {
      const a = await reg('getAIConfig', [id])
      return { modelIdHashes: a.modelIdHashes, promptHash: a.promptHash, calibratorHash: a.calibratorHash, categoryId: a.categoryId, highConfBps: Number(a.highConfBps) }
    },
    async text(id) {
      const [question, rules] = await Promise.all([reg('getQuestion', [id]), reg('getRules', [id])])
      return { question, rules }
    },
    async l1Url(id) {
      const f = await reg('getFeedSpec', [id])
      return buildUrl({ ...f, valueType: Number(f.valueType), op: Number(f.op), decimals: Number(f.decimals) })
    },
    async allowList(id) {
      return reg('getAllowList', [id])
    },
    async activeTrustSetId() {
      return Number(await ro('activeTrustSetId'))
    },
    async categoryValidated(categoryId, gateHash) {
      const cat = await reg('category', [categoryId])
      return cat.validated && cat.gateHash === gateHash
    },
    async simulate(id, r, uri, sig) {
      const { result } = await pc.simulateContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'submitPanelResult', args: [id, r, uri, sig] as never, account, blockTag: 'latest' })
      return Number(result)
    },
    async send(id, r, uri, sig, gas) {
      return wc.writeContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'submitPanelResult', args: [id, r, uri, sig] as never, gas, account, chain })
    },
    async submissionStatus(hash, id, phase, evidenceHash) {
      let receipt
      try { receipt = await pc.getTransactionReceipt({ hash }) }
      catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return 'pending'
        throw error
      }
      const finalized = await pc.getBlock({ blockTag: 'finalized' })
      if (receipt.blockNumber > finalized.number) return 'pending'
      const block = await pc.getBlock({ blockNumber: receipt.blockNumber })
      return panelReceiptStatus(receipt, finalized.number, block.hash, oracle, id, phase, evidenceHash)
    },
  }
}
