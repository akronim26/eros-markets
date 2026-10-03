// Task O31.4: a local deploy of the whole oracle stack for the keeper's scenario tests (plan §11.3). A fresh anvil
// (Monad's 128 KiB code limit) gets exactly what O19.3/O19.4 run before a testnet launch: DeployUmaSandbox and
// DeployOracle broadcast, CreateTrustSet and FundTreasury proposed by the team Safe and executed through the
// Timelock after its delay, and the example listing pack listed by the Safe's transaction that ListMarket prints.
// The sim bridge's forwarder is MockKeystoneForwarderLite (header-faithful KeystoneForwarder, O15.1) placed at the
// params' mockForwarder address, so the test plays the CRE relayer; the test also plays the disputer and the DVM
// (ErosSandboxOracle's owner is the Safe). Nothing here touches a public network.
import {
  ErosSandboxOracleAbi,
  IAssertionVenueAbi,
  loadDeployments,
  MarketRegistryAbi,
  ORACLE_ROOT,
  ResolutionOracleAbi,
  TestUSDCAbi,
  type Deployments,
} from '@eros-oracle/oracle-sdk'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  type Hex,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type PublicClient,
  stringToBytes,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

// anvil's default accounts. #1 stands in for the team Safe (also the lister and the sandbox owner), #2 the
// guardian Safe, #3 an unrelated Timelock executor, #4 the sim relayer (tx.origin of a CRE report), #5 a disputer.
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  safe: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  guardian: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  executor: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  relayer: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  disputer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
} as const satisfies Record<string, Hex>
const addr = (k: keyof typeof KEYS) => privateKeyToAccount(KEYS[k]).address

export const PACK = 'listings/example/pack.json'
const FORGE_TIMEOUT_MS = 600_000

const OOV3_ABI = parseAbi(['function disputeAssertion(bytes32 assertionId, address disputer)'])
const FORWARDER_ABI = parseAbi(['function report(address receiver, bytes raw) returns (bool)'])

export type Stack = {
  rpcUrl: string
  deployments: Deployments
  pc: PublicClient
  /** The example pack's market id. */
  marketId: Hex
  stop(): Promise<void>
}

function forge(args: string[], env: Record<string, string>): string {
  const p = Bun.spawnSync(['forge', ...args], {
    cwd: ORACLE_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: FORGE_TIMEOUT_MS,
  })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0) throw new Error(`forge ${args.slice(0, 2).join(' ')} failed (exit ${p.exitCode}):\n${out.slice(-4000)}`)
  return out
}

/** The bytes a script printed on the line after `label`. */
function printed(out: string, label: string): Hex[] {
  const lines = out.split('\n')
  const found: Hex[] = []
  lines.forEach((l, i) => {
    if (l.includes(label)) found.push(lines[i + 1].trim() as Hex)
  })
  return found
}

async function waitForRpc(url: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
      if (res.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`anvil at ${url} did not start`)
}

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/** Starts anvil on `port` and deploys, configures and funds the stack; the chain is left at the deploy. */
/**
 * Deploy options: the trust set's runner attestor, committee and watchdog (default placeholders no one holds; the
 * panel, committee and watchdog tests pass their keys' addresses).
 */
export type StackOptions = { attestor?: Address; committee?: readonly Address[]; watchdog?: Address }

export async function deployStack(port: number, opts: StackOptions = {}): Promise<Stack> {
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = Bun.spawn(['anvil', '--port', String(port), '--code-size-limit', '131072', '--silent'], { stdout: 'ignore', stderr: 'ignore' })
  const dir = `deployments/dryrun/keeper-fork-${port}` // gitignored; scripts may write under ./deployments
  const abs = join(ORACLE_ROOT, dir)
  try {
    await waitForRpc(rpcUrl)
    rmSync(abs, { recursive: true, force: true })
    mkdirSync(abs, { recursive: true })

    const params = JSON.parse(readFileSync(join(ORACLE_ROOT, 'deployments/params.monad-testnet.json'), 'utf8'))
    params.providers = ['api.example-sports.com', 'stats.example-data.org'] // the example pack's hosts
    writeFileSync(join(abs, 'params.json'), JSON.stringify(params, null, 2))
    const env: Record<string, string> = {
      DEPLOYMENTS_DIR: dir,
      DEPLOYMENTS: `${dir}/anvil.json`,
      PARAMS: `${dir}/params.json`,
      TEAM_SAFE: addr('safe'),
      GUARDIAN_SAFE: addr('guardian'),
      SANDBOX_OWNER: addr('safe'),
      SIM_RELAYERS: addr('relayer'),
      // trust-set members the keeper scenarios never act as (no panel, committee or watchdog path is exercised there)
      ATTESTOR: opts.attestor ?? '0x00000000000000000000000000000000000A77E5',
      WATCHDOG: opts.watchdog ?? '0x000000000000000000000000000000000000DA7C',
      COMMITTEE: (opts.committee ?? ['0x0000000000000000000000000000000000000C01', '0x0000000000000000000000000000000000000C02', '0x0000000000000000000000000000000000000C03']).join(','),
    }
    const script = (name: string, extra: Record<string, string> = {}, broadcast = false) =>
      forge(['script', `script/${name}.s.sol`, '--rpc-url', rpcUrl, ...(broadcast ? ['--broadcast', '--private-key', KEYS.deployer, '--code-size-limit', '131072', '--non-interactive'] : [])], { ...env, ...extra })

    forge(['build'], {}) // the sandbox script loads UMA's 0.8.16 artifacts; the forwarder's comes from out/
    script('DeployUmaSandbox', {}, true)
    script('DeployOracle', {}, true)
    const deployments = loadDeployments('anvil', { path: join(abs, 'anvil.json'), expectChainId: 31337 })

    const pc = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient
    const wallet = (k: keyof typeof KEYS) => createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(KEYS[k]) })
    const send = async (k: keyof typeof KEYS, to: Address, data: Hex) => {
      const hash = await wallet(k).sendTransaction({ to, data })
      const r = await pc.waitForTransactionReceipt({ hash })
      if (r.status !== 'success') throw new Error(`${k} → ${to}: reverted`)
    }
    // Every operation a governance script printed: proposed by the Safe, executed by a stranger after the delay.
    const throughTimelock = async (out: string) => {
      const proposals = printed(out, 'Safe transaction: to TIMELOCK')
      const executions = printed(out, 'After the delay, anyone: execute')
      if (proposals.length === 0 || proposals.length !== executions.length) throw new Error(`no Timelock operation in:\n${out.slice(-2000)}`)
      const timelock = deployments.roles.timelock as Address
      for (let i = 0; i < proposals.length; i++) {
        await send('safe', timelock, proposals[i])
        await rpc(rpcUrl, 'evm_increaseTime', [params.timelockDelaySecs])
        await rpc(rpcUrl, 'evm_mine')
        await send('executor', timelock, executions[i])
      }
    }
    await throughTimelock(script('CreateTrustSet')) // the sim trust set, then globals, providers, auth refs
    await throughTimelock(script('FundTreasury', { DEPOSIT: 'true', MINT: 'true' }, true)) // limits; deposits broadcast

    // The CRE sim bridge: CreateTrustSet pointed the oracle at params.cre.mockForwarder.
    const artifact = JSON.parse(readFileSync(resolve(ORACLE_ROOT, process.env.FOUNDRY_OUT ?? 'out', 'MockKeystoneForwarderLite.sol/MockKeystoneForwarderLite.json'), 'utf8'))
    await rpc(rpcUrl, 'anvil_setCode', [params.cre.mockForwarder, artifact.deployedBytecode.object])

    const pack = JSON.parse(readFileSync(join(ORACLE_ROOT, PACK), 'utf8'))
    return {
      rpcUrl,
      deployments,
      pc,
      marketId: pack.marketInput.marketId as Hex,
      async stop() {
        anvil.kill()
        await anvil.exited
        rmSync(abs, { recursive: true, force: true })
      },
    }
  } catch (e) {
    anvil.kill()
    rmSync(abs, { recursive: true, force: true })
    throw e
  }
}

/** The example pack, its times moved to the chain's now, listed by the Safe's transaction from ListMarket. */
/**
 * The example pack (or `edit` of it: written next to the deployments, where ListMarket may read it), its times moved
 * to the chain's now, listed by the Safe's transaction from ListMarket.
 */
export async function listExample(s: Stack, edit?: (pack: any) => void): Promise<Hex> {
  const dir = `deployments/dryrun/keeper-fork-${new URL(s.rpcUrl).port}`
  let packPath = PACK
  let marketId = s.marketId
  if (edit) {
    const pack = JSON.parse(readFileSync(join(ORACLE_ROOT, PACK), 'utf8'))
    edit(pack)
    packPath = `${dir}/pack.json`
    writeFileSync(join(ORACLE_ROOT, packPath), JSON.stringify(pack, null, 2))
    marketId = pack.marketInput.marketId
  }
  const out = forge(['script', 'script/ListMarket.s.sol', '--rpc-url', s.rpcUrl], {
    DEPLOYMENTS: `${dir}/anvil.json`,
    PARAMS: `${dir}/params.json`,
    PACK: packPath,
    SHIFT_TO_NOW: 'true',
  })
  const [data] = printed(out, 'Lister transaction (the team Safe)')
  const to = s.deployments.contracts.MarketRegistry.address as Address
  await sendFrom(s, 'safe', to, data)
  return marketId as Hex
}

async function sendFrom(s: Stack, k: keyof typeof KEYS, to: Address, data: Hex) {
  const w = createWalletClient({ chain: foundry, transport: http(s.rpcUrl), account: privateKeyToAccount(KEYS[k]) })
  const r = await s.pc.waitForTransactionReceipt({ hash: await w.sendTransaction({ to, data }) })
  if (r.status !== 'success') throw new Error(`${k} → ${to}: reverted`)
  return r
}

// ------------------------------------------------------------------ chain control

export const now = async (s: Stack) => (await s.pc.getBlock({ blockTag: 'latest' })).timestamp

/** Mines a block at `t` (or now + 1 if `t` is not later). */
export async function warpTo(s: Stack, t: bigint) {
  const cur = await now(s)
  await rpc(s.rpcUrl, 'evm_setNextBlockTimestamp', [Number(t > cur ? t : cur + 1n)])
  await rpc(s.rpcUrl, 'evm_mine')
}

export const snapshot = async (s: Stack) => (await rpc(s.rpcUrl, 'evm_snapshot')) as Hex
export async function revertTo(s: Stack, id: Hex) {
  if (!(await rpc(s.rpcUrl, 'evm_revert', [id]))) throw new Error(`evm_revert ${id} failed`)
}

export async function fund(s: Stack, a: Address) {
  await rpc(s.rpcUrl, 'anvil_setBalance', [a, '0x56bc75e2d63100000']) // 100 ETH
}

// ------------------------------------------------------------------ reads

const oracle = (s: Stack) => s.deployments.contracts.ResolutionOracle.address as Address

export async function resolution(s: Stack, id: Hex) {
  return s.pc.readContract({ address: oracle(s), abi: ResolutionOracleAbi, functionName: 'getResolution', args: [id] })
}

export async function venueStatus(s: Stack, id: Hex) {
  const r = await resolution(s, id)
  return s.pc.readContract({ address: r.assertionVenue as Address, abi: IAssertionVenueAbi, functionName: 'statusOf', args: [r.assertionId] })
}

// ------------------------------------------------------------------ the other actors

/**
 * The CRE workflow's Layer 1 report (report v1: eight ABI words, §6.4), relayed through the sim forwarder by the
 * sim relayer. Throws unless the oracle accepted it.
 */
export async function reportL1(s: Stack, id: Hex, outcome: 1 | 2, observedAt: bigint) {
  const specHash = await s.pc.readContract({ address: s.deployments.contracts.MarketRegistry.address as Address, abi: MarketRegistryAbi, functionName: 'getSpecHash', args: [id] })
  const report = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, bytes32, uint256, uint256, bytes32, bytes32'), [
    1n,
    BigInt(s.deployments.creChainSelector),
    BigInt(oracle(s)),
    id,
    BigInt(outcome),
    observedAt,
    keccak256(stringToBytes('3')),
    specHash,
  ])
  const header = encodePacked(['uint8', 'bytes32', 'uint32', 'uint32', 'uint32', 'bytes32', 'bytes10', 'address', 'bytes2'], [
    1,
    keccak256(encodePacked(['bytes32', 'uint256'], [id, observedAt])), // workflow execution id
    Number(observedAt),
    1,
    1,
    keccak256(stringToBytes('eros-resolution-stg')),
    `0x${Buffer.from('eros-resol').toString('hex')}` as Hex,
    addr('relayer'),
    '0x0001',
  ])
  const forwarder = (await s.pc.readContract({ address: oracle(s), abi: ResolutionOracleAbi, functionName: 'simForwarder' })) as Address
  const w = createWalletClient({ chain: foundry, transport: http(s.rpcUrl), account: privateKeyToAccount(KEYS.relayer) })
  await s.pc.waitForTransactionReceipt({ hash: await w.writeContract({ address: forwarder, abi: FORWARDER_ABI, functionName: 'report', args: [oracle(s), `${header}${report.slice(2)}` as Hex] }) })
  const r = await resolution(s, id)
  if (r.state !== 7) throw new Error(`the oracle did not accept the report: state ${r.state}`)
}

/** A third party disputes the live assertion on UMA's OOv3 with their own bond. */
export async function dispute(s: Stack, id: Hex) {
  const r = await resolution(s, id)
  const usdc = s.deployments.usdc as Address
  const oov3 = s.deployments.uma.oov3 as Address
  const w = createWalletClient({ chain: foundry, transport: http(s.rpcUrl), account: privateKeyToAccount(KEYS.disputer) })
  for (const call of [
    { address: usdc, abi: TestUSDCAbi, functionName: 'mint', args: [addr('disputer'), r.bond] },
    { address: usdc, abi: TestUSDCAbi, functionName: 'approve', args: [oov3, r.bond] },
    { address: oov3, abi: OOV3_ABI, functionName: 'disputeAssertion', args: [r.assertionId, addr('disputer')] },
  ] as const) {
    const rc = await s.pc.waitForTransactionReceipt({ hash: await w.writeContract(call as never) })
    if (rc.status !== 'success') throw new Error(`dispute: ${call.functionName} reverted`)
  }
}

/** The DVM answers the dispute's price request: the sandbox oracle's owner (the Safe) pushes `truthful`. */
export async function dvmAnswer(s: Stack, truthful: boolean) {
  const sandbox = s.deployments.uma.sandboxOracle as Address
  const logs = await s.pc.getContractEvents({ address: sandbox, abi: ErosSandboxOracleAbi, eventName: 'PriceRequested', fromBlock: 0n })
  const requestId = logs.at(-1)!.args.requestId as Hex
  const w = createWalletClient({ chain: foundry, transport: http(s.rpcUrl), account: privateKeyToAccount(KEYS.safe) })
  const hash = await w.writeContract({ address: sandbox, abi: ErosSandboxOracleAbi, functionName: 'pushPriceByRequestId', args: [requestId, truthful ? 10n ** 18n : 0n] })
  if ((await s.pc.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error('pushPriceByRequestId reverted')
}
