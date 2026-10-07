// Fresh, resumable testnet deployment. Plans and receipts are public; signed bytes
// and role keys remain in the ignored, owner-only run directory.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeDeployData, encodeFunctionData,
  getContractAddress, http, keccak256, parseEther, stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hex, type Transaction, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { loadArtifacts } from './integrated-preflight'

const ROOT = resolve(import.meta.dir, '../../..')
const RPC = 'https://testnet-rpc.monad.xyz'
export const MODE = '0x0100000000007821000100000000000000000000000000000000000000000000' as Hex
const DELAY = 300n
const MAX_GAS = 30_000_000n
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function deployerAccount() {
  const key = parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')).PRIVATE_KEY
  if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('ROOT_PRIVATE_KEY_REQUIRED')
  return privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex)
}

export function atomicWrite(path: string, value: unknown) {
  const temp = `${path}.tmp`
  writeFileSync(temp, json(value), { mode: 0o600 })
  const fd = openSync(temp, 'r'); fsyncSync(fd); closeSync(fd)
  renameSync(temp, path)
}

export function artifact(name: string) {
  const a = read(resolve(ROOT, `oracle/out/${name}.sol/${name}.json`))
  const m = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata
  if (!/^0x[0-9a-f]+$/i.test(a.bytecode.object) || !m?.compiler?.version
    || !/^(0\.8\.30|0\.8\.16)\+/.test(m.compiler.version) || !m.settings.optimizer.enabled
    || m.settings.optimizer.runs !== 200
    || m.settings.evmVersion !== (m.compiler.version.startsWith('0.8.16+') ? 'london' : 'prague')) throw new Error(`UNPINNED_ARTIFACT:${name}`)
  for (const [path, source] of Object.entries(m.sources) as [string, { keccak256: Hex }][]) {
    const bytes = readFileSync(resolve(ROOT, 'oracle', path))
    if (keccak256(toHex(bytes)) !== source.keccak256) throw new Error(`STALE_ARTIFACT:${name}`)
  }
  return a
}

export type Step = { name: string; nonce: number; to?: Address; data: Hex; expectedAddress?: Address; contract?: string; waitSeconds?: number; gasMarginBps?: number; valueWei?: string }
export type Plan = { schema: string; chainId: 10143; sourceCommit: string; deployer: Address; startNonce: number;
  preparedBlock: string; preparedBlockHash: Hex; roles: Record<string, Address>; addresses: Record<string, Address>;
  steps: Step[]; maxTotalGasCostWei: string; infrastructure: { forwarder: Address; codehash: Hex } }

export function operation(calls: { to: Address; value: bigint; data: Hex }[], label: string) {
  const opData = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [zeroHash, keccak256(stringToHex(label))])
  return encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }, { type: 'bytes' }], [calls, opData])
}

export function buildBasePlan(deployer: Address, nonce: number, roles: Record<string, Address>, infrastructure: Plan['infrastructure']) {
  loadArtifacts() // Includes exact source, compiler and runtime-size validation for the engine.
  const addresses: Record<string, Address> = {}, steps: Step[] = []
  const deploy = (name: string, args: unknown[] = [], contract = name) => {
    const a = artifact(contract), n = nonce + steps.length
    const expectedAddress = getContractAddress({ from: deployer, nonce: BigInt(n) })
    steps.push({ name: `deploy:${name}`, nonce: n, contract, expectedAddress,
      data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }) })
    addresses[name] = expectedAddress
    return expectedAddress
  }
  const call = (name: string, contract: string, to: Address, fn: string, args: unknown[]) => {
    steps.push({ name, nonce: nonce + steps.length, to, data: encodeFunctionData({ abi: artifact(contract).abi, functionName: fn, args }) })
  }
  const token = deploy('TestUSDC')
  const finder = deploy('Finder')
  const store = deploy('Store', [{ rawValue: 0n }, { rawValue: 0n }, zeroAddress])
  call('uma:final-fee', 'Store', store, 'setFinalFee', [token, { rawValue: 1_000_000n }])
  const whitelist = deploy('AddressWhitelist')
  call('uma:collateral', 'AddressWhitelist', whitelist, 'addToWhitelist', [token])
  const identifiers = deploy('IdentifierWhitelist')
  call('uma:identifier', 'IdentifierWhitelist', identifiers, 'addSupportedIdentifier', [stringToHex('ASSERT_TRUTH', { size: 32 })])
  const sandbox = deploy('ErosSandboxOracle', [deployer])
  for (const [label, target] of Object.entries({ Store: store, CollateralWhitelist: whitelist, IdentifierWhitelist: identifiers, Oracle: sandbox }))
    call(`uma:finder:${label}`, 'Finder', finder, 'changeImplementationAddress', [stringToHex(label, { size: 32 }), target])
  const oov3 = deploy('OptimisticOracleV3', [finder, token, 7200n])
  call('uma:requester', 'ErosSandboxOracle', sandbox, 'setRequester', [oov3])
  const timelock = deploy('Timelock')
  call('governance:initialize', 'Timelock', timelock, 'initialize', [DELAY, zeroAddress, [deployer], [deployer], [deployer]])
  const n = nonce + steps.length
  const treasuryAt = getContractAddress({ from: deployer, nonce: BigInt(n) })
  const oracleAt = getContractAddress({ from: deployer, nonce: BigInt(n + 1) })
  const adapterAt = getContractAddress({ from: deployer, nonce: BigInt(n + 2) })
  const registryAt = getContractAddress({ from: deployer, nonce: BigInt(n + 3) })
  deploy('BondTreasury', [token, oracleAt, registryAt, timelock])
  deploy('ResolutionOracle', [registryAt, treasuryAt, token, 2183018362218727504n, timelock, deployer])
  deploy('UmaAdapter', [oov3, token, oracleAt, treasuryAt])
  deploy('MarketRegistry', [oracleAt, treasuryAt, zeroAddress, token, timelock, deployer])
  deploy('KeeperRouter', [oracleAt])
  const code = artifact('RegistryBookRiskEngine').bytecode.object as Hex
  const first = `0x${code.slice(2, 200002)}` as Hex, second = `0x${code.slice(200002)}` as Hex
  const head = deploy('EngineCodeStore', [first])
  const tail = deploy('EngineCodeStoreTail', [second], 'EngineCodeStore')
  const factory = deploy('MarketFactory', [registryAt, token, deployer, head, tail, keccak256(code)])
  deploy('RolloverBatcher')
  const params = read(resolve(ROOT, 'oracle/deployments/params.monad-testnet.json'))
  const governanceCalls: { to: Address; value: bigint; data: Hex }[] = []
  const govern = (contract: string, to: Address, functionName: string, args: unknown[]) =>
    governanceCalls.push({ to, value: 0n, data: encodeFunctionData({ abi: artifact(contract).abi, functionName, args }) })
  const trust = { forwarder: infrastructure.forwarder, production: false, workflowIds: [zeroHash, zeroHash],
    workflowOwner: zeroAddress, workflowName: '0x00000000000000000000', runnerAttestor: roles.RUNNER_ATTESTOR,
    committee: [roles.COMMITTEE_1, roles.COMMITTEE_2, roles.COMMITTEE_3].sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    threshold: 2, watchdog: roles.WATCHDOG, venue: adapterAt }
  govern('ResolutionOracle', oracleAt, 'createTrustSet', [trust])
  govern('ResolutionOracle', oracleAt, 'activateTrustSet', [1])
  govern('ResolutionOracle', oracleAt, 'setSimForwarder', [infrastructure.forwarder])
  govern('ResolutionOracle', oracleAt, 'setSimRelayer', [roles.SIM_RELAYER, true])
  govern('MarketRegistry', registryAt, 'setGlobals', [{ ...params.globals, maxVoidSecs: 30 * 86400 }])
  for (const host of ['gamma-api.polymarket.com', 'clob.polymarket.com', 'statsapi.mlb.com'])
    govern('MarketRegistry', registryAt, 'setProvider', [host, true])
  govern('MarketRegistry', registryAt, 'setFactory', [factory])
  govern('BondTreasury', treasuryAt, 'setLimits', [1000_000000n, 20])
  const execution = operation(governanceCalls, `eros-fresh-testnet:${deployer}:${nonce}:base`)
  call('governance:propose-base', 'Timelock', timelock, 'propose', [MODE, execution, DELAY])
  call('governance:execute-base', 'Timelock', timelock, 'execute', [MODE, execution])
  steps.at(-1)!.waitSeconds = Number(DELAY)
  call('treasury:faucet', 'TestUSDC', token, 'mint', [deployer, 1100_000000n])
  call('treasury:approve', 'TestUSDC', token, 'approve', [treasuryAt, 1100_000000n])
  call('treasury:assertion', 'BondTreasury', treasuryAt, 'deposit', [0, 1000_000000n])
  call('treasury:watchdog', 'BondTreasury', treasuryAt, 'deposit', [1, 100_000000n])
  return { addresses, steps }
}

export function client(endpoint: string, account?: ReturnType<typeof privateKeyToAccount>) {
  const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [endpoint] } } })
  return { public: createPublicClient({ chain, transport: http(endpoint, { retryCount: 3 }) }),
    wallet: createWalletClient({ chain, account, transport: http(endpoint, { retryCount: 0 }) }) }
}

export function paddedGas(estimate: bigint, marginBps = 1000) {
  if (!Number.isInteger(marginBps) || marginBps < 500 || marginBps > 2000) throw new Error('INVALID_GAS_MARGIN')
  const gas = (estimate * BigInt(10000 + marginBps) + 9999n) / 10000n + 10_000n
  if (gas > MAX_GAS) throw new Error('GAS_MARGIN_EXCEEDS_30M')
  return gas
}

export function runtimeMatches(actual: Hex, compiled: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> }) {
  if (actual.length !== compiled.object.length) return false
  let live = actual.slice(2).toLowerCase(), expected = compiled.object.slice(2).toLowerCase()
  for (const refs of Object.values(compiled.immutableReferences ?? {})) for (const ref of refs) {
    const mask = '0'.repeat(ref.length * 2), start = ref.start * 2, end = start + ref.length * 2
    live = live.slice(0, start) + mask + live.slice(end)
    expected = expected.slice(0, start) + mask + expected.slice(end)
  }
  return live === expected
}

export function recordCanonicalPlanReceipt({ plan, step, entry, receipt, canonical, transaction }: {
  plan: Pick<Plan, 'deployer'>
  step: Step
  entry: { hash: Hex; raw?: Hex; receipt?: unknown }
  receipt: Pick<TransactionReceipt, 'status' | 'transactionHash' | 'blockNumber' | 'blockHash' | 'contractAddress'>
  canonical: { number: bigint | null; hash: Hex | null }
  transaction: Pick<Transaction, 'hash' | 'from' | 'to' | 'nonce' | 'input' | 'value' | 'blockNumber' | 'blockHash'>
}) {
  const sameHex = (a: string | null | undefined, b: string | null | undefined) =>
    typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
  // viem may resolve a same-nonce replacement's receipt. A successful receipt
  // only proves this journal entry when both hashes and mined block agree.
  // Validate before recording confirmation or discarding uncertain signed bytes.
  if (!sameHex(receipt.transactionHash, entry.hash)
    || !sameHex(transaction.hash, entry.hash) || transaction.blockNumber !== receipt.blockNumber
    || !sameHex(transaction.blockHash, receipt.blockHash) || canonical.number !== receipt.blockNumber
    || !sameHex(canonical.hash, receipt.blockHash) || transaction.from.toLowerCase() !== plan.deployer.toLowerCase()
    || transaction.value !== BigInt(step.valueWei ?? 0) || transaction.nonce !== step.nonce || transaction.input.toLowerCase() !== step.data.toLowerCase()
    || (transaction.to ?? '').toLowerCase() !== (step.to ?? '').toLowerCase()
    || (receipt.status === 'success' && step.expectedAddress
      && receipt.contractAddress?.toLowerCase() !== step.expectedAddress.toLowerCase())) throw new Error('CANONICAL_RECEIPT_MISMATCH')
  if (receipt.status !== 'success') throw new Error(`TRANSACTION_REVERTED:${step.name}:${entry.hash}`)
  entry.receipt = JSON.parse(json(receipt))
  delete entry.raw
}

async function verifyBase(plan: Plan, pc: ReturnType<typeof client>['public'], journal: any) {
  const block = await pc.getBlock({ blockTag: journal.broadcast ? 'finalized' : 'latest' }), a = plan.addresses
  const contracts: Record<string, unknown> = {}
  const readAt = (contract: string, target: Address, functionName: string, args: unknown[] = []) =>
    pc.readContract({ address: target, abi: artifact(contract).abi, functionName, args, blockNumber: block.number })
  const check = async (contract: string, target: Address, fn: string, expected: unknown, args: unknown[] = []) => {
    const actual = await readAt(contract, target, fn, args)
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`BINDING_MISMATCH:${contract}.${fn}`)
  }
  const engineCode = artifact('RegistryBookRiskEngine').bytecode.object as Hex
  for (const step of plan.steps.filter(step => step.expectedAddress)) {
    const code = await pc.getCode({ address: step.expectedAddress!, blockNumber: block.number })
    const expectedStore = step.name === 'deploy:EngineCodeStore' ? `0x00${engineCode.slice(2, 200002)}`
      : step.name === 'deploy:EngineCodeStoreTail' ? `0x00${engineCode.slice(200002)}` : null
    if (!code || (expectedStore ? code.toLowerCase() !== expectedStore.toLowerCase() : !runtimeMatches(code, artifact(step.contract!).deployedBytecode)))
      throw new Error(`RUNTIME_MISMATCH:${step.name}`)
    const entry = journal.steps.find((e: any) => e.name === step.name)
    contracts[step.name.replace('deploy:', '')] = { address: step.expectedAddress, codehash: keccak256(code), deployBlock: Number(entry.receipt.blockNumber), transactionHash: entry.hash }
  }
  const vault = await readAt('MarketFactory', a.MarketFactory, 'collateralVault') as Address
  const vaultCode = await pc.getCode({ address: vault, blockNumber: block.number })
  if (!vaultCode || !runtimeMatches(vaultCode, artifact('CollateralVault').deployedBytecode)) throw new Error('VAULT_RUNTIME_MISMATCH')
  contracts.CollateralVault = { address: vault, codehash: keccak256(vaultCode), deployBlock: (contracts.MarketFactory as any).deployBlock }
  contracts.CollateralToken = contracts.TestUSDC
  const links = [
    ['BondTreasury', 'oracle', a.ResolutionOracle], ['BondTreasury', 'registry', a.MarketRegistry], ['BondTreasury', 'usdc', a.TestUSDC], ['BondTreasury', 'governance', a.Timelock],
    ['ResolutionOracle', 'registry', a.MarketRegistry], ['ResolutionOracle', 'treasury', a.BondTreasury], ['ResolutionOracle', 'usdc', a.TestUSDC], ['ResolutionOracle', 'governance', a.Timelock], ['ResolutionOracle', 'guardian', plan.deployer],
    ['MarketRegistry', 'oracle', a.ResolutionOracle], ['MarketRegistry', 'treasury', a.BondTreasury], ['MarketRegistry', 'usdc', a.TestUSDC], ['MarketRegistry', 'governance', a.Timelock], ['MarketRegistry', 'lister', plan.deployer], ['MarketRegistry', 'factory', a.MarketFactory],
    ['MarketFactory', 'registry', a.MarketRegistry], ['UmaAdapter', 'oov3', a.OptimisticOracleV3], ['UmaAdapter', 'usdc', a.TestUSDC], ['UmaAdapter', 'oracle', a.ResolutionOracle], ['UmaAdapter', 'treasury', a.BondTreasury],
    ['KeeperRouter', 'oracle', a.ResolutionOracle], ['ErosSandboxOracle', 'requester', a.OptimisticOracleV3], ['ErosSandboxOracle', 'owner', plan.deployer],
  ] as const
  for (const [contract, fn, expected] of links) await check(contract, a[contract], fn, expected)
  await check('Timelock', a.Timelock, 'minDelay', DELAY)
  for (const role of ['PROPOSER_ROLE','EXECUTOR_ROLE','CANCELLER_ROLE'])
    await check('Timelock', a.Timelock, 'hasRole', true, [plan.deployer, await readAt('Timelock', a.Timelock, role)])
  await check('ResolutionOracle', a.ResolutionOracle, 'simMode', true)
  await check('ResolutionOracle', a.ResolutionOracle, 'activeTrustSetId', 1)
  await check('ResolutionOracle', a.ResolutionOracle, 'simForwarder', plan.infrastructure.forwarder)
  await check('ResolutionOracle', a.ResolutionOracle, 'isSimRelayer', true, [plan.roles.SIM_RELAYER])
  await check('TestUSDC', a.TestUSDC, 'decimals', 6)
  await check('TestUSDC', a.TestUSDC, 'balanceOf', 1100_000000n, [a.BondTreasury])
  const forwarderCode = await pc.getCode({ address: plan.infrastructure.forwarder, blockNumber: block.number })
  if (!forwarderCode || keccak256(forwarderCode) !== plan.infrastructure.codehash) throw new Error('FORWARDER_IDENTITY_CHANGED')
  if ((await pc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('VERIFICATION_BLOCK_REORGED')
  return { schema: 'eros-fresh-testnet-base-verification/1', passed: true, sourceCommit: plan.sourceCommit,
    chainId: plan.chainId, deployer: plan.deployer, roles: plan.roles, contracts,
    verifiedAt: { blockNumber: block.number.toString(), blockHash: block.hash },
    provenance: { collateral: 'testnet', calibration: 'synthetic', resolution: 'oracle',
      oracleDelivery: 'CRE simulation forwarder; not a deployed CRE network workflow', uma: 'UMA OOv3 with owner-controlled testnet DVM sandbox' } }
}

export async function executePlan(plan: Plan, directory: string, endpoint: string, broadcast: boolean,
  phase = 'base', verify: (plan: Plan, pc: ReturnType<typeof client>['public'], journal: any) => Promise<unknown> = verifyBase, signer?: ReturnType<typeof privateKeyToAccount>) {
  if (!/^[a-z-]+$/.test(phase)) throw new Error('INVALID_PHASE')
  let account: ReturnType<typeof privateKeyToAccount> | undefined
  if (broadcast) {
    account = signer ?? deployerAccount()
    if (account.address.toLowerCase() !== plan.deployer.toLowerCase()) throw new Error('DEPLOYER_CHANGED')
  } else {
    const u = new URL(endpoint)
    if (u.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(u.hostname) || u.username || u.password) throw new Error('REHEARSAL_LOOPBACK_REQUIRED')
  }
  const c = client(endpoint, account), pc = c.public
  if (await pc.getChainId() !== 10143) throw new Error('WRONG_CHAIN')
  if (!broadcast) {
    if (!String(await pc.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('REHEARSAL_ANVIL_REQUIRED')
    await pc.request({ method: 'anvil_impersonateAccount', params: [plan.deployer] } as never)
  }
  const prefix = phase === 'base' ? '' : `${phase}-`
  const filename = resolve(directory, `${prefix}${broadcast ? 'broadcast' : 'rehearsal'}-journal.json`)
  const planHash = keccak256(stringToHex(json(plan)))
  const journal = existsSync(filename) ? read(filename) : { planHash, broadcast, steps: [], status: 'running' }
  if (journal.planHash !== planHash || journal.broadcast !== broadcast) throw new Error('JOURNAL_PLAN_MISMATCH')
  atomicWrite(filename, journal)
  let maximumCost = 0n
  for (const [index, step] of plan.steps.entries()) {
    let entry = journal.steps[index]
    if (entry && (entry.name !== step.name || entry.nonce !== step.nonce)) throw new Error('JOURNAL_STEP_MISMATCH')
    if (!entry) {
      if (step.waitSeconds) {
        const prior = journal.steps[index - 1]
        const proposalBlock = await pc.getBlock({ blockNumber: BigInt(prior.receipt.blockNumber) })
        const ready = proposalBlock.timestamp + BigInt(step.waitSeconds)
        if (!broadcast) await pc.request({ method: 'evm_increaseTime', params: [step.waitSeconds + 1] } as never)
        if (!broadcast) await pc.request({ method: 'evm_mine' } as never)
        while ((await pc.getBlock()).timestamp < ready) await pause(1000)
      }
      const block = await pc.getBlock()
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => pc.getTransactionCount({ address: plan.deployer, blockTag: blockTag as 'latest' | 'pending' })))
      if (latest !== step.nonce || pending !== step.nonce) throw new Error(`NONCE_CHANGED:${step.name}`)
      const tx = { account: plan.deployer, ...(step.to ? { to: step.to } : {}), data: step.data, value: BigInt(step.valueWei ?? 0) }
      const estimate = await pc.estimateGas({ ...tx, gas: MAX_GAS, blockNumber: block.number })
      const gas = paddedGas(estimate, step.gasMarginBps), gasPrice = await pc.getGasPrice()
      maximumCost = journal.steps.reduce((sum: bigint, e: any, i: number) => sum + BigInt(e.gas) * BigInt(e.gasPrice) + BigInt(plan.steps[i].valueWei ?? 0), 0n) + gas * gasPrice + tx.value
      if (maximumCost > BigInt(plan.maxTotalGasCostWei)) throw new Error('DEPLOYMENT_COST_BUDGET_EXCEEDED')
      if (await pc.getBalance({ address: plan.deployer }) < gas * gasPrice + tx.value) throw new Error('INSUFFICIENT_GAS_FUNDS')
      entry = { name: step.name, nonce: step.nonce, gas: gas.toString(), gasPrice: gasPrice.toString(), estimate: estimate.toString(), simulationBlock: block.number.toString() }
      if (broadcast) {
        entry.raw = await c.wallet.signTransaction({ ...tx, account: account!, nonce: step.nonce, gas, gasPrice, type: 'legacy' })
        entry.hash = keccak256(entry.raw)
      }
      journal.steps.push(entry); atomicWrite(filename, journal)
    }
    if (!entry.hash) {
      if (broadcast) throw new Error('SIGNED_BYTES_MISSING')
      entry.hash = await c.wallet.sendTransaction({ account: plan.deployer, ...(step.to ? { to: step.to } : {}), data: step.data,
        value: BigInt(step.valueWei ?? 0), nonce: step.nonce, gas: BigInt(entry.gas), gasPrice: BigInt(entry.gasPrice), type: 'legacy' })
      atomicWrite(filename, journal)
    } else if (!entry.receipt && broadcast) {
      const known = await pc.getTransaction({ hash: entry.hash }).catch((error) => {
        if (error.name === 'TransactionNotFoundError') return null
        throw error
      })
      if (!known) {
        if (!entry.raw || keccak256(entry.raw) !== entry.hash) throw new Error('SIGNED_BYTES_CHANGED')
        const nonce = await pc.getTransactionCount({ address: plan.deployer, blockTag: 'latest' })
        if (nonce > step.nonce) throw new Error('NONCE_CONSUMED_WITHOUT_EXPECTED_TRANSACTION')
        await c.wallet.sendRawTransaction({ serializedTransaction: entry.raw })
      }
    }
    const receipt = await pc.waitForTransactionReceipt({ hash: entry.hash, timeout: 180000 })
    if (broadcast) while ((await pc.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber) await pause(500)
    const [canonical, transaction] = await Promise.all([pc.getBlock({ blockNumber: receipt.blockNumber }), pc.getTransaction({ hash: entry.hash })])
    recordCanonicalPlanReceipt({ plan, step, entry, receipt, canonical, transaction })
    atomicWrite(filename, journal)
    console.log(json({ step: index + 1, total: plan.steps.length, name: step.name, hash: entry.hash, gasUsed: receipt.gasUsed }).trim())
  }
  const verification = await verify(plan, pc, journal)
  atomicWrite(resolve(directory, broadcast ? `${phase}-verification.json` : `${prefix}rehearsal-verification.json`), verification)
  journal.status = 'passed'; atomicWrite(filename, journal)
  return journal
}

async function prepare(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
  if (existsSync(resolve(directory, 'base-plan.json'))) throw new Error('PLAN_ALREADY_EXISTS')
  const deployer = deployerAccount().address
  const pc = client(RPC).public
  if (await pc.getChainId() !== 10143) throw new Error('WRONG_CHAIN')
  const block = await pc.getBlock({ blockTag: 'finalized' })
  const nonce = await pc.getTransactionCount({ address: deployer, blockTag: 'pending' })
  if (nonce !== await pc.getTransactionCount({ address: deployer, blockTag: 'latest' })) throw new Error('PENDING_DEPLOYER_TRANSACTION')
  const rolePath = resolve(directory, 'roles.env')
  if (!existsSync(rolePath)) {
    const lines = ['INDEX_SIGNER','PUBLISHER','KEEPER','SIM_RELAYER','RUNNER_ATTESTOR','COMMITTEE_1','COMMITTEE_2','COMMITTEE_3','WATCHDOG','MAKER_BUY','MAKER_SELL']
      .map(name => `${name}_PRIVATE_KEY=${generatePrivateKey()}`)
    writeFileSync(rolePath, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  }
  const roleEnv = parseEnv(readFileSync(rolePath, 'utf8'))
  const roles = Object.fromEntries(Object.entries(roleEnv).map(([name, key]) => [name.replace(/_PRIVATE_KEY$/, ''), privateKeyToAccount(key as Hex).address]))
  const existing = read(resolve(ROOT, 'oracle/deployments/monad-testnet.json'))
  const forwarder = existing.cre.mockForwarder as Address
  const code = await pc.getCode({ address: forwarder, blockNumber: block.number })
  if (!code || code === '0x') throw new Error('NETWORK_SIMULATION_FORWARDER_MISSING')
  const infrastructure = { forwarder, codehash: keccak256(code) }
  const plan: Plan = { schema: 'eros-fresh-testnet-base/1', chainId: 10143,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    deployer, startNonce: nonce, preparedBlock: block.number.toString(), preparedBlockHash: block.hash,
    roles, infrastructure, ...buildBasePlan(deployer, nonce, roles, infrastructure), maxTotalGasCostWei: parseEther('10').toString() }
  atomicWrite(resolve(directory, 'base-plan.json'), plan)
  console.log(json({ status: 'prepared', deployer, nonce, steps: plan.steps.length, addresses: plan.addresses, roles }))
}

if (import.meta.main) {
  const [command, dir, endpoint] = process.argv.slice(2)
  if (!dir) throw new Error('Usage: fresh-testnet.ts prepare|rehearse|broadcast RUN_DIRECTORY [LOOPBACK_RPC]')
  const directory = resolve(dir)
  try {
    if (command === 'prepare') await prepare(directory)
    else if (command === 'rehearse' || command === 'broadcast') {
      const plan = read(resolve(directory, 'base-plan.json')) as Plan
      const rehearsal = command === 'broadcast' ? read(resolve(directory, 'rehearsal-journal.json')) : null
      if (rehearsal && (rehearsal.status !== 'passed' || rehearsal.planHash !== keccak256(stringToHex(json(plan))))) throw new Error('PASSING_REHEARSAL_REQUIRED')
      const lock = resolve(directory, 'execution.lock')
      mkdirSync(lock) // Exclusive ownership; a stale lock requires receipt review.
      try { await executePlan(plan, directory, command === 'broadcast' ? RPC : endpoint, command === 'broadcast') }
      finally { rmSync(lock, { recursive: true }) }
    } else throw new Error('UNKNOWN_COMMAND')
  } catch (error) {
    // RPC error objects may contain endpoints or serialized requests; print only
    // our bounded error code or the exception type, never a signing object.
    const e = error as Error
    console.error(/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message) ? e.message : e.name)
    process.exitCode = 1
  }
}
