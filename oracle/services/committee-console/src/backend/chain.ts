// Task O34.1: the console's CaseChain over viem. Reads at `latest`. StateChanged and PanelResultAccepted logs are read
// once per process from `fromBlock` (default the oracle's deploy block) in 100-block steps (Monad's public RPC caps log
// ranges, plan §9.3) and cached; later calls read only the new blocks. submitReviewedProposal is eth_called, then sent
// with an explicit gas limit (Monad charges the limit).
import { contractAddress, type Deployments, MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { buildUrl } from '@eros-oracle/feedspec'
import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { CaseChain, PanelEvent } from './types'

const STEP = 100n
const ERC1271 = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const ERC1271_MAGIC = '0x1626ba7e'
const event = (name: string) => ResolutionOracleAbi.find((x) => x.type === 'event' && x.name === name)!

type Logged = { id: Hex; block: bigint; logIndex: number }
type StateLog = Logged & { to: number }
type PanelLog = Logged & Omit<PanelEvent, 'at'>

export function viemCaseChain(opts: { rpcUrl: string; deployments: Deployments; relayerKey?: Hex; fromBlock?: bigint }): CaseChain {
  const d = opts.deployments
  const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [opts.rpcUrl] } } })
  const pc = createPublicClient({ chain, transport: http(opts.rpcUrl) })
  const oracle = contractAddress(d, 'ResolutionOracle')
  const registry = contractAddress(d, 'MarketRegistry')
  const reg = (functionName: string, args: readonly unknown[]) =>
    pc.readContract({ address: registry, abi: MarketRegistryAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>
  const ro = (functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: functionName as never, args: args as never, blockTag: 'latest' }) as Promise<any>

  let next = opts.fromBlock ?? BigInt(d.contracts.ResolutionOracle.deployBlock)
  const states: StateLog[] = []
  const panels: PanelLog[] = []
  const times = new Map<bigint, bigint>()
  async function sync() {
    const head = await pc.getBlockNumber()
    for (; next <= head; next += STEP) {
      const to = next + STEP - 1n < head ? next + STEP - 1n : head
      const logs = (await pc.getLogs({ address: oracle, events: [event('StateChanged'), event('PanelResultAccepted')] as never, fromBlock: next, toBlock: to })) as any[]
      for (const l of logs) {
        const base = { id: (l.args.id as Hex).toLowerCase() as Hex, block: l.blockNumber as bigint, logIndex: l.logIndex as number }
        if (l.eventName === 'StateChanged') states.push({ ...base, to: Number(l.args.to) })
        else
          panels.push({
            ...base,
            phase: Number(l.args.phase),
            labels: l.args.labels.map(Number),
            calibratedBps: l.args.calibratedBps.map(Number),
            evidenceHash: l.args.evidenceHash,
            evidenceURI: l.args.evidenceURI,
            routedTo: Number(l.args.routedTo),
          })
      }
    }
  }
  async function blockTime(n: bigint) {
    if (!times.has(n)) times.set(n, (await pc.getBlock({ blockNumber: n })).timestamp)
    return times.get(n)!
  }
  const relayer = opts.relayerKey ? privateKeyToAccount(opts.relayerKey) : undefined

  return {
    chainId: d.chainId,
    oracle,
    async now() {
      return (await pc.getBlock({ blockTag: 'latest' })).timestamp
    },
    async resolution(id) {
      const r = await ro('getResolution', [id])
      return {
        state: Number(r.state),
        attempts: Number(r.attempts),
        rejectedMask: Number(r.rejectedMask),
        haltedAt: BigInt(r.haltedAt),
        voidDeadline: BigInt(r.voidDeadline),
        l2StartedAt: BigInt(r.l2StartedAt),
        retryOpensAt: BigInt(r.retryOpensAt),
        earlyStartedAt: BigInt(r.earlyStartedAt),
        trustSetId: Number(r.trustSetId),
      }
    },
    async core(id) {
      const c = await reg('getMarketCore', [id])
      return { tau: BigInt(c.tau), hasFeed: c.hasFeed, gateHash: c.gateHash, l2DeadlineSecs: BigInt(c.l2DeadlineSecs), earlyTtlSecs: BigInt(c.earlyTtlSecs) }
    },
    async text(id) {
      const [question, rules] = await Promise.all([reg('getQuestion', [id]), reg('getRules', [id])])
      return { question, rules }
    },
    async allowList(id) {
      return reg('getAllowList', [id])
    },
    async l1Url(id) {
      const c = await reg('getMarketCore', [id])
      if (!c.hasFeed) return undefined
      const f = await reg('getFeedSpec', [id])
      return buildUrl({ ...f, valueType: Number(f.valueType), op: Number(f.op), decimals: Number(f.decimals) })
    },
    async activeTrustSetId() {
      return Number(await ro('activeTrustSetId'))
    },
    async committee(setId) {
      const t = await ro('trustSet', [setId])
      const members = t.cfg.committee as Address[]
      const revoked = await Promise.all(members.map((m) => ro('isMemberRevoked', [setId, m]) as Promise<boolean>))
      return { members, threshold: Number(t.cfg.threshold), revoked }
    },
    async lastPanelResult(id) {
      await sync()
      const p = panels.filter((x) => x.id === id.toLowerCase()).at(-1)
      if (!p) return null
      const { id: _id, block, logIndex: _i, ...rest } = p
      return { ...rest, at: await blockTime(block) }
    },
    async enteredAt(id, state) {
      await sync()
      const s = states.filter((x) => x.id === id.toLowerCase() && x.to === state).at(-1)
      return s ? blockTime(s.block) : null
    },
    async markets() {
      await sync()
      return [...new Set(states.map((s) => s.id))]
    },
    async isContract(a) {
      const code = await pc.getCode({ address: a, blockTag: 'latest' })
      return code !== undefined && code !== '0x'
    },
    async isValidSignature(signer, digest, signature) {
      try {
        const r = await pc.readContract({ address: signer, abi: ERC1271, functionName: 'isValidSignature', args: [digest, signature], blockTag: 'latest' })
        return r.toLowerCase() === ERC1271_MAGIC
      } catch {
        return false
      }
    },
    async simulateReviewed(id, p, uri, sigs) {
      await pc.simulateContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'submitReviewedProposal', args: [id, p, uri, sigs] as never, account: relayer?.address ?? oracle, blockTag: 'latest' })
    },
    async sendReviewed(id, p, uri, sigs, gas) {
      if (!relayer) throw new Error('set RELAYER_PRIVATE_KEY to submit')
      const wc = createWalletClient({ chain, transport: http(opts.rpcUrl), account: relayer })
      return wc.writeContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'submitReviewedProposal', args: [id, p, uri, sigs] as never, gas, account: relayer, chain })
    },
  }
}
