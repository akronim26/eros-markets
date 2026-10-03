// Task O31.1: the Chain the keeper uses, over viem (plan §9): reads at `latest`, eth_call before sending, an
// explicit gas limit on every transaction, and no waiting on receipts (Monad executes asynchronously; the next
// tick re-reads instead).
import { BondTreasuryAbi, type Deployments, KeeperRouterAbi, ResolutionOracleAbi, contractAddress } from '@eros-oracle/oracle-sdk'
import {
  type Abi,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  TransactionReceiptNotFoundError,
} from 'viem'
import { nonceManager, privateKeyToAccount } from 'viem/accounts'
import type { Chain, Job, Resolution, Target } from './types'

const ABIS: Record<Target, Abi> = {
  ResolutionOracle: ResolutionOracleAbi as Abi,
  KeeperRouter: KeeperRouterAbi as Abi,
  BondTreasury: BondTreasuryAbi as Abi,
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
  const call = (job: Job) => ({
    address: contractAddress(d, job.target),
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
