// The parties a scenario plays that the running services do not: a third-party disputer, the sandbox DVM (the
// team Safe stand-in), the monitor, a permissionless proposer, the committee (through its console) and, for
// the exclusive-group race (E9), a second Layer 1 report relayed by the sim relayer.
import { ErosSandboxOracleAbi, IOptimisticOracleV3Abi, ORACLE_ROOT, ResolutionEngineStubAbi, ResolutionOracleAbi, TestUSDCAbi, UmaAdapterAbi } from '@eros-oracle/oracle-sdk'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, encodeAbiParameters, encodePacked, type Hex, keccak256, parseAbi, parseAbiParameters, stringToBytes, type TransactionReceipt } from 'viem'
import { resolution } from './market'
import { addr, at, d, env, key, pc, type Role, send, withLock } from './stack'
import { engineAdapter } from './engine'

const usdc = d.usdc as Address
const oov3 = d.uma.oov3 as Address
const sandbox = d.uma.sandboxOracle as Address

async function fundUsdc(role: Role, spender: Address, amount: bigint) {
  await send(role, usdc, TestUSDCAbi, 'mint', [addr(role), amount])
  await send(role, usdc, TestUSDCAbi, 'approve', [spender, amount])
}

/** A third party disputes the live assertion on OOv3 with its own bond; returns the receipt (it holds the DVM request). */
export async function publicDispute(id: Hex, role: Role = 'KEEPER_1'): Promise<TransactionReceipt> {
  const r = await resolution(id)
  await fundUsdc(role, oov3, r.bond)
  return send(role, oov3, IOptimisticOracleV3Abi, 'disputeAssertion', [r.assertionId, addr(role)])
}

/** The DVM request a dispute opened: the sandbox oracle's PriceRequested in the dispute transaction. */
export function dvmRequestOf(dispute: TransactionReceipt): Hex {
  const log = dispute.logs.find((l) => l.address.toLowerCase() === sandbox.toLowerCase())
  if (!log?.topics[1]) throw new Error(`no sandbox PriceRequested in ${dispute.transactionHash}`)
  return log.topics[1]
}

/** The sandbox DVM (owner: the team Safe stand-in) answers whether the disputed claim is true. */
export const dvmAnswer = (requestId: Hex, truthful: boolean) =>
  send('LISTER', sandbox, ErosSandboxOracleAbi, 'pushPriceByRequestId', [requestId, truthful ? 10n ** 18n : 0n])

/** The DVM request of the market's live (disputed) assertion, from the venue's dispute log scan of recent blocks. */
export async function dvmRequestForLiveAssertion(id: Hex, fromBlock: bigint): Promise<Hex> {
  const r = await resolution(id)
  const head = await pc.getBlockNumber()
  for (let b = fromBlock; b <= head; b += 100n) {
    const logs = await pc.getLogs({ address: oov3, fromBlock: b, toBlock: b + 99n > head ? head : b + 99n })
    for (const l of logs) {
      if (l.topics[1]?.toLowerCase() !== r.assertionId.toLowerCase()) continue
      const rc = await pc.getTransactionReceipt({ hash: l.transactionHash! })
      const s = rc.logs.find((x) => x.address.toLowerCase() === sandbox.toLowerCase())
      if (s?.topics[1]) return s.topics[1]
    }
  }
  throw new Error(`${id.slice(0, 10)}: no DVM request found for assertion ${r.assertionId}`)
}

/** The monitor (the market's listing.monitor) restricts the engine and requests an early check. */
export async function earlyCheck(id: Hex, engine: Address, monitor: Role) {
  const call = await engineAdapter.restriction(engine, keccak256(stringToBytes(`e2e:${id}:early-check`)))
  const a = await send(monitor, engine, call.abi, call.functionName, call.args)
  const b = await send(monitor, at('ResolutionOracle'), ResolutionOracleAbi, 'requestEarlyCheck', [id])
  return [a, b]
}

/** A permissionless proposal in Open with the proposer's own bond. */
export async function proposePermissionless(id: Hex, outcome: 1 | 2 | 3, role: Role = 'KEEPER_1') {
  const bond = (await pc.readContract({ address: at('ResolutionOracle'), abi: ResolutionOracleAbi, functionName: 'bondFor', args: [id] })) as bigint
  await fundUsdc(role, at('UmaAdapter'), bond)
  const uri = `https://statsapi.mlb.com/api/v1/schedule (permissionless proposal by ${addr(role)})`
  return send(role, at('ResolutionOracle'), ResolutionOracleAbi, 'proposePermissionless', [id, outcome, uri, keccak256(stringToBytes(uri))])
}

const FORWARDER_ABI = parseAbi(['function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)'])

/**
 * A Layer 1 report (v1) relayed by the sim relayer through the CRE MockKeystoneForwarder, as `cre workflow
 * simulate --broadcast` sends it. Used only where a scenario needs a report the real feed would not give.
 */
export async function simReport(id: Hex, outcome: 1 | 2, observedAt: bigint, valueHash: Hex) {
  const specHash = (await pc.readContract({ address: at('MarketRegistry'), abi: (await import('@eros-oracle/oracle-sdk')).MarketRegistryAbi, functionName: 'getSpecHash', args: [id] })) as Hex
  const oracle = at('ResolutionOracle')
  const body = encodeAbiParameters(parseAbiParameters('uint8, uint64, address, bytes32, uint8, uint64, bytes32, bytes32'), [
    1, BigInt(d.creChainSelector), oracle, id, outcome, observedAt, valueHash, specHash,
  ])
  const header = encodePacked(['uint8', 'bytes32', 'uint32', 'uint32', 'uint32', 'bytes32', 'bytes10', 'address', 'bytes2'], [
    1, keccak256(encodePacked(['bytes32', 'uint64'], [id, observedAt])), Number(observedAt), 1, 1,
    keccak256(stringToBytes('eros-resolution-sim')), `0x${Buffer.from('eros-resol').toString('hex')}` as Hex, addr('SIM_RELAYER'), '0x0001',
  ])
  const forwarder = (await pc.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'simForwarder' })) as Address
  return send('SIM_RELAYER', forwarder, FORWARDER_ABI as never, 'report', [oracle, `${header}${body.slice(2)}` as Hex, '0x', []])
}

// ------------------------------------------------------------------ committee (the reviewer console)

const CONSOLE = join(ORACLE_ROOT, 'services/committee-console/src/ui/main.ts')
const DATA_DIR = join(ORACLE_ROOT, 'deployments/dryrun/e2e-committee')

function console_(member: 1 | 2 | 3, args: string[]): string {
  for (let i = 0; ; i++) {
    try {
      return consoleOnce(member, args)
    } catch (e) {
      if (i >= 4 || !/RPC Request failed|limited|429|timeout|fetch failed/i.test(String(e))) throw e
      Bun.sleepSync(3000 * (i + 1))
    }
  }
}

function consoleOnce(member: 1 | 2 | 3, args: string[]): string {
  const p = Bun.spawnSync(['bun', CONSOLE, ...args], {
    cwd: ORACLE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 300_000,
    env: {
      ...process.env,
      NETWORK: 'monad-testnet',
      RPC_URL: env('MONAD_TESTNET_RPC'),
      COMMITTEE_PRIVATE_KEY: key(`COMMITTEE_${member}` as Role),
      RELAYER_PRIVATE_KEY: key('COMMITTEE_1'),
      SNAPSHOT_DIR: env('SNAPSHOT_DIR'),
      DATA_DIR,
      FROM_BLOCK: env('E2E_FROM_BLOCK'),
    },
  })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0) throw new Error(`console ${args[0]} failed:\n${out.slice(-2000)}`)
  return out
}

const latestBundle = () => {
  const dir = join(DATA_DIR, 'proposals')
  return join(dir, readdirSync(dir).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f)
}

/** Two members sign a reviewed proposal through the console, then member 1 submits it (eth_call first). */
export async function committeePropose(id: Hex, outcome: 'YES' | 'NO' | 'INVALID', note: string, second: 2 | 3 = 2): Promise<Hex> {
  return withLock(addr('COMMITTEE_1'), async () => {
    const before = Date.now()
    console_(1, ['propose', id, outcome, note])
    const bundle = latestBundle()
    if (statSync(bundle).mtimeMs < before) throw new Error('the console wrote no new bundle')
    console_(second, ['sign', bundle, outcome])
    for (let i = 0; ; i++) {
      try {
        const tx = console_(1, ['submit', bundle]).trim().split('\n').pop()!.trim() as Hex
        const r = await pc.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        if (r.status !== 'success') throw new Error(`reviewed proposal reverted: ${tx}`)
        return tx
      } catch (e) {
        if (i >= 3) throw e
        await Bun.sleep(5000)
      }
    }
  })
}

/** The console's eth_call of a reviewed proposal that must be refused (E3: a rejected outcome is not repeated). */
export function committeeRefused(id: Hex, outcome: 'YES' | 'NO', note: string): string {
  try {
    console_(1, ['propose', id, outcome, note])
    const bundle = latestBundle()
    console_(2, ['sign', bundle, outcome])
    return `NOT REFUSED: ${console_(1, ['submit', bundle]).trim().split('\n').pop()}`
  } catch (e) {
    return String(e).split('\n').find((l) => /Rejected|revert|Error/i.test(l)) ?? String(e).slice(0, 300)
  }
}

export const venueStatus = async (id: Hex) => {
  const r = await resolution(id)
  return pc.readContract({ address: r.assertionVenue, abi: UmaAdapterAbi, functionName: 'statusOf', args: [r.assertionId] })
}
