// Recorded local events as Envio simulate items: local addresses are replaced by testnet ones, and blocks are moved
// past the testnet start blocks.
import { readFileSync } from 'node:fs'
import { type Abi, decodeEventLog, parseAbi } from 'viem'
import { parse } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
export const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/recorded/events.json', import.meta.url), 'utf8'))
const D = JSON.parse(readFileSync(`${ROOT}deployments/monad-testnet.json`, 'utf8'))
export const BLOCK_OFFSET = 67_901_624 // the oracle's testnet deployBlock: every replayed block is at or after it

export const TESTNET: Record<string, string> = {
  ResolutionOracle: D.contracts.ResolutionOracle.address,
  MarketRegistry: D.contracts.MarketRegistry.address,
  BondTreasury: D.contracts.BondTreasury.address,
  UmaAdapter: D.contracts.UmaAdapter.address,
  OptimisticOracleV3: D.uma.oov3,
  ErosSandboxOracle: D.uma.sandboxOracle,
  KeystoneForwarder: D.cre.mockForwarder,
}

const abi = (n: string) => JSON.parse(readFileSync(`${ROOT}abi/${n}.json`, 'utf8')) as Abi
const ABIS: Record<string, Abi> = {
  ResolutionOracle: abi('ResolutionOracle'),
  MarketRegistry: abi('MarketRegistry'),
  BondTreasury: abi('BondTreasury'),
  UmaAdapter: abi('UmaAdapter'),
  ErosSandboxOracle: abi('ErosSandboxOracle'),
  OptimisticOracleV3: parseAbi([
    'event AssertionMade(bytes32 indexed assertionId, bytes32 domainId, bytes claim, address indexed asserter, address callbackRecipient, address escalationManager, address caller, uint64 expirationTime, address currency, uint256 bond, bytes32 indexed identifier)',
    'event AssertionDisputed(bytes32 indexed assertionId, address indexed caller, address indexed disputer)',
    'event AssertionSettled(bytes32 indexed assertionId, address indexed bondRecipient, bool disputed, bool settlementResolution, address settleCaller)',
  ]),
  KeystoneForwarder: parseAbi(['event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)']),
}

/** The events config.yaml indexes, per contract ("Name" or a full signature "Name(...)"). */
export const INDEXED: Record<string, string[]> = Object.fromEntries(
  (parse(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')).contracts as { name: string; events: { event: string }[] }[]).map((c) => [
    c.name,
    c.events.map((e) => e.event.split('(')[0]!),
  ]),
)

const local: Record<string, string> = Object.fromEntries(Object.entries(RECORDED.addresses as Record<string, string>).map(([k, v]) => [v.toLowerCase(), k]))
const mapAddress = (v: unknown) => (typeof v === 'string' && local[v.toLowerCase()] ? TESTNET[local[v.toLowerCase()]!] : v)

/** Integers become bigint (as Envio delivers every integer); recorded contract addresses become testnet ones. */
function convert(type: string, v: unknown): unknown {
  if (type.endsWith('[]')) return (v as unknown[]).map((x) => convert(type.slice(0, -2), x))
  const fixed = /^(.*)\[\d+\]$/.exec(type)
  if (fixed) return (v as unknown[]).map((x) => convert(fixed[1]!, x))
  if (/^u?int\d*$/.test(type)) return BigInt(v as number | bigint)
  if (type === 'address') return mapAddress(v)
  return v
}

export type Item = { contract: string; event: string; srcAddress: string; logIndex: number; block: { number: number; timestamp: number; hash: string }; transaction: { hash: string; from: string }; params: Record<string, unknown> }

export function simulateItems(): Item[] {
  const out: Item[] = []
  for (const l of RECORDED.logs) {
    const contract = local[l.address.toLowerCase()]
    if (!contract || !INDEXED[contract]) continue
    let d: { eventName: string; args: Record<string, unknown> }
    try {
      d = decodeEventLog({ abi: ABIS[contract]!, topics: l.topics, data: l.data }) as never
    } catch {
      continue // an event this source's ABI does not define (e.g. OwnershipTransferred on OOv3)
    }
    if (!INDEXED[contract].includes(d.eventName)) continue
    const inputs = (ABIS[contract]!.find((x) => x.type === 'event' && x.name === d.eventName) as unknown as { inputs: { name: string; type: string }[] }).inputs
    out.push({
      contract,
      event: d.eventName,
      srcAddress: TESTNET[contract]!,
      logIndex: l.logIndex,
      block: { ...l.block, number: l.block.number + BLOCK_OFFSET },
      transaction: { hash: l.transactionHash, from: l.from },
      params: Object.fromEntries(inputs.map((i) => [i.name, convert(i.type, d.args[i.name])])),
    })
  }
  return out
}
