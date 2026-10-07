// Reproducible CRE + public API + deployed-contract verification. All sends go to
// a private Anvil fork. The public Monad RPC is used only for reads.
import { MarketRegistryAbi, ResolutionEngineStubAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPublicClient, createWalletClient, defineChain, http, parseAbiItem, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { at, env, pc as publicChain, retry } from './stack'

const market = '0x858d339df94e447f28cac9130cb11988a9219bf5e0bcae4ff2fd336d9428c7d9' as const
const originalReport = '0xeb0b9e751e27c7c627fb03585035129d7078a5cb2259c97eb87f129fe18dadb1' as const
const port = Number(process.env.CRE_TEST_PORT ?? 8559)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CRE_TEST_PORT')
const rpcUrl = `http://127.0.0.1:${port}`
const root = resolve(import.meta.dir, '../..')
const output = resolve(process.env.EVIDENCE_DIR ?? join(root, 'deployments/dryrun', `cre-verify-${Date.now()}`))
mkdirSync(output, { recursive: true })
const secretDir = mkdtempSync(join(tmpdir(), 'eros-cre-verify-'))
const stringify = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v, 2)
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); console.log(`PASS ${message}`) }
const original = await retry(() => publicChain.getTransactionReceipt({ hash: originalReport }))
assert(original.status === 'success', 'historical Monad CRE report succeeded')
const forkBlock = original.blockNumber - 1n
const trigger = parseAbiItem('event ResolutionRequested(bytes32 indexed marketId,uint64 requestedAt,uint32 requestCount)')
const logs = await retry(() => publicChain.getLogs({ address: at('ResolutionOracle'), event: trigger, args: { marketId: market }, fromBlock: forkBlock - 99n, toBlock: forkBlock, strict: true }))
assert(logs.length === 1, 'unique historical resolution request found')
const request = logs[0]
const receipt = await retry(() => publicChain.getTransactionReceipt({ hash: request.transactionHash }))
const receiptIndex = receipt.logs.findIndex(log => log.logIndex === request.logIndex)
assert(receiptIndex >= 0, 'request receipt index found')
// Refuse to attach to or reset an unrelated process already using the chosen port.
try {
  await fetch(rpcUrl, { signal: AbortSignal.timeout(500) })
  throw new Error('CRE_TEST_PORT is already in use')
} catch (error) {
  if ((error as Error).message === 'CRE_TEST_PORT is already in use') throw error
}
const anvil = Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '10143',
  '--fork-url', env('MONAD_TESTNET_RPC'), '--fork-block-number', String(forkBlock), '--code-size-limit', '131072', '--silent'],
  { stdout: 'ignore', stderr: 'ignore' })
const chain = defineChain({ id: 10143, name: 'Isolated Monad test fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
const local = createPublicClient({ chain, transport: http(rpcUrl) })
let cli: ReturnType<typeof Bun.spawn> | undefined
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    try { ready = await local.getChainId() === 10143; if (ready) break } catch { /* startup */ }
    await Bun.sleep(500)
  }
  assert(ready, 'isolated fork started')
  const oracle = at('ResolutionOracle')
  const resolution = () => local.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'getResolution', args: [market] })
  assert((await resolution()).state === 3, 'fork starts at L1Pending')
  const envFile = join(secretDir, '.env')
  writeFileSync(envFile, `MONAD_TESTNET_RPC=${rpcUrl}\nCRE_ETH_PRIVATE_KEY=${env('CRE_ETH_PRIVATE_KEY')}\n`, { mode: 0o600 })
  const logFile = join(output, 'cre-simulation.log')
  const running = Bun.spawn([process.env.CRE_BIN ?? 'cre', 'workflow', 'simulate', 'resolution', '--target', 'local-sim', '--limits', 'default',
    '--trigger-index', '0', '--evm-tx-hash', request.transactionHash, '--evm-event-index', String(receiptIndex),
    '--broadcast', '--non-interactive', '-e', envFile], {
    cwd: join(root, 'workflows'),
    // Explicit process env prevents an inherited public RPC from overriding the isolated env file.
    env: { ...process.env, MONAD_TESTNET_RPC: rpcUrl, CRE_ETH_PRIVATE_KEY: env('CRE_ETH_PRIVATE_KEY') },
    stdout: 'pipe', stderr: 'pipe',
  })
  cli = running
  const timer = setTimeout(() => cli?.kill(), 180_000)
  let stdout: string, stderr: string, code: number
  try { [stdout, stderr, code] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]) }
  finally { clearTimeout(timer); cli = undefined }
  writeFileSync(logFile, stdout + stderr)
  assert(code === 0, 'CRE CLI simulation exited successfully')
  const result = stdout.match(new RegExp(`proposed:${market}:YES:(0x[0-9a-fA-F]{64})`))
  assert(result, 'CRE evaluated the external API and proposed YES')
  const reportTx = result![1] as Hex
  assert((await local.getTransactionReceipt({ hash: reportTx })).status === 'success', 'CRE report transaction succeeded on the fork')
  const proposed = await resolution()
  assert(proposed.state === 7 && proposed.path === 1 && proposed.proposed === 1, 'oracle accepted the Layer 1 proposal')
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(env('KEEPER_1_PRIVATE_KEY') as Hex) })
  const assertion = await wallet.writeContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'assertProposal', args: [market] })
  assert((await local.waitForTransactionReceipt({ hash: assertion })).status === 'success', 'assertion accepted')
  const liveness = await local.readContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'livenessFor', args: [market] })
  // Test-only clock travel, never called on the public client.
  await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: [Number(liveness) + 1] }) })
  await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'evm_mine', params: [] }) })
  const finalization = await wallet.writeContract({ address: oracle, abi: ResolutionOracleAbi, functionName: 'finalizeMarket', args: [market] })
  assert((await local.waitForTransactionReceipt({ hash: finalization })).status === 'success', 'finalization transaction succeeded')
  const final = await resolution()
  const core = await local.readContract({ address: at('MarketRegistry'), abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [market] })
  const settlement = await local.readContract({ address: core.engine, abi: ResolutionEngineStubAbi, functionName: 'getSettlementStatus' })
  assert(final.state === 10 && final.outcome === 1 && final.path === 1, 'oracle finalized YES through Layer 1')
  assert(settlement.oracleFinalityAccepted && settlement.claimsEnabled && settlement.finalOutcome === 2, 'deployed test engine accepted YES and enabled claims')
  writeFileSync(join(output, 'run.json'), stringify({ scope: 'local fork only; real external API and CRE CLI; test settlement engine', checkedAt: new Date().toISOString(), forkBlock, originalReport, request: request.transactionHash,
    market, engine: core.engine, reportTx, assertion, finalization, livenessSeconds: liveness, final, settlement }) + '\n')
  console.log(`Evidence: ${output}`)
} finally {
  cli?.kill()
  anvil.kill()
  await anvil.exited
  rmSync(secretDir, { recursive: true, force: true })
}
