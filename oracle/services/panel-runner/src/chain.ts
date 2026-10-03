// Task O33.5: the runner's PanelChain over viem. Reads at `latest`; StateChanged logs read in 100-block steps (Monad's
// public RPC caps log ranges, plan §9.3); submitPanelResult eth_called, then sent from the relayer EOA with an explicit
// gas limit (Monad charges the limit) and no wait on the receipt.
import { contractAddress, type Deployments, MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { buildUrl } from '@eros-oracle/feedspec'
import { createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import type { PanelChain } from './runner'

const STEP = 100n
const STATE_CHANGED = ResolutionOracleAbi.find((x) => x.type === 'event' && x.name === 'StateChanged')!

export function viemPanelChain(opts: { rpcUrl: string; relayerKey: Hex; deployments: Deployments; fromBlock?: bigint }): PanelChain {
  const d = opts.deployments
  const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
  const pc = createPublicClient({ chain, transport: http(opts.rpcUrl) })
  const account = privateKeyToAccount(opts.relayerKey, { nonceManager })
  const wc = createWalletClient({ chain, transport: http(opts.rpcUrl), account })
  const oracle = contractAddress(d, 'ResolutionOracle')
  const registry = contractAddress(d, 'MarketRegistry')
  let next = opts.fromBlock ?? BigInt(d.contracts.ResolutionOracle.deployBlock)
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
    async stateChanges() {
      const head = await pc.getBlockNumber()
      const out: { id: Hex; to: number }[] = []
      for (; next <= head; next += STEP) {
        const to = next + STEP - 1n < head ? next + STEP - 1n : head
        const logs = await pc.getLogs({ address: oracle, event: STATE_CHANGED as never, fromBlock: next, toBlock: to })
        for (const l of logs as unknown as { args: { id: Hex; to: number } }[]) out.push({ id: l.args.id, to: Number(l.args.to) })
      }
      return out
    },
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
  }
}
