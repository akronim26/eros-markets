// Recorded local events as Envio simulate items: local addresses and block numbers are
// rebased onto the active indexer config, preserving event order and recorded timestamps.
import { readFileSync } from 'node:fs'
import { type Abi, decodeEventLog, parseAbi } from 'viem'
import { parse } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
export const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/recorded/events.json', import.meta.url), 'utf8'))
type Source = { name: string; address: string | string[]; start_block?: number }
const config = parse(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')) as {
  contracts: { name: string; events: { event: string }[] }[]
  chains: { id: number; start_block: number; contracts: Source[] }[]
}
const chain = config.chains.find(c => c.id === 10143)
if (!chain) throw new Error('Fixture replay requires a Monad testnet indexer configuration')
// Envio applies both chain and per-contract routing start blocks to simulated events.
export const BLOCK_OFFSET = Math.max(chain.start_block, ...chain.contracts.map(c => c.start_block ?? chain.start_block))
export const AFTER_REPLAY_BLOCK = BLOCK_OFFSET + Math.max(...RECORDED.logs.map((l: { block: { number: number } }) => l.block.number)) + 1
export const TESTNET: Record<string, string> = Object.fromEntries(chain.contracts.map(c => {
  // A simulated log has one emitter; use the first configured engine when there are several.
  const address = Array.isArray(c.address) ? c.address[0] : c.address
  if (!address) throw new Error(`Fixture replay requires a configured address for ${c.name}`)
  return [c.name, address.toLowerCase()]
}))
export function fixtureAddress(contract: string): string {
  const address = TESTNET[contract]
  if (!address) throw new Error(`Fixture replay requires a configured address for ${contract}`)
  return address
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
  config.contracts.map((c) => [
    c.name,
    c.events.map((e) => e.event.split('(')[0]!),
  ]),
)

const local: Record<string, string> = Object.fromEntries(Object.entries(RECORDED.addresses as Record<string, string>).map(([k, v]) => [v.toLowerCase(), k]))
const mapAddress = (v: unknown) => (typeof v === 'string' && local[v.toLowerCase()] ? fixtureAddress(local[v.toLowerCase()]!) : v)

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
      srcAddress: fixtureAddress(contract),
      logIndex: l.logIndex,
      block: { ...l.block, number: l.block.number + BLOCK_OFFSET },
      transaction: { hash: l.transactionHash, from: l.from },
      params: Object.fromEntries(inputs.map((i) => [i.name, convert(i.type, d.args[i.name])])),
    })
  }
  return out
}
