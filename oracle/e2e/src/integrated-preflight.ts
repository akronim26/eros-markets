/** Exact integrated deployment preparation. Public RPC transport is read-only;
 * optional transaction rehearsal is restricted to a disposable loopback Anvil. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, custom, encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, getContractAddress,
  keccak256, parseAbi, parseAbiParameters, stringToHex, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = resolve(ROOT, 'oracle/out')
const MAX_GAS = 30_000_000n
const MODE = '0x0100000000007821000100000000000000000000000000000000000000000000' as Hex
const OPEN_ROLE = '0x0303030303030303030303030303030303030303' as Address
const timelockAbi = parseAbi(['function minDelay() view returns (uint256)', 'function hasRole(address,uint256) view returns (bool)',
  'function propose(bytes32 mode,bytes executionData,uint256 delay) returns (bytes32)', 'function execute(bytes32 mode,bytes executionData) payable',
  'function readyTimestamp(bytes32 id) view returns (uint256)'])
const tokenAbi = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'])

export const READ_METHODS = new Set(['eth_chainId', 'web3_clientVersion', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  'eth_getCode', 'eth_getStorageAt', 'eth_getProof', 'eth_call', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice'])
const LOCAL_METHODS = new Set(['anvil_impersonateAccount', 'anvil_stopImpersonatingAccount', 'anvil_setBalance',
  'anvil_nodeInfo', 'evm_increaseTime', 'evm_mine', 'evm_snapshot', 'evm_revert', 'eth_sendTransaction'])

export function assertLoopback(endpoint: string): void {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('Rehearsal requires a loopback Anvil RPC')
}

export function rpcTransport(endpoint: string, allowLocal = false) {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid RPC URL')
  if (allowLocal) assertLoopback(endpoint)
  let localVerified = false
  let nextId = 0
  return {
    verifyLocal(clientVersion: string) {
      if (!allowLocal || !clientVersion.toLowerCase().includes('anvil')) throw new Error('Rehearsal requires Anvil')
      localVerified = true
    },
    async request({ method, params = [] }: { method: string; params?: unknown }): Promise<any> {
      if (!READ_METHODS.has(method) && !(localVerified && LOCAL_METHODS.has(method))) throw new Error(`RPC method forbidden: ${method}`)
      const id = ++nextId
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`)
      const data = await response.json() as { id?: unknown; error?: { code?: number }; result?: unknown }
      if (data.id !== id || data.error || !Object.hasOwn(data, 'result')) throw new Error(`RPC ${method} failed${data.error ? ` (${data.error.code})` : ''}`)
      return data.result
    },
  }
}

function json(value: unknown) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) }
function sha256(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex') }
export function exactJson(text: string): any {
  const value = JSON.parse(text)
  const check = (item: unknown): void => {
    if (typeof item === 'number' && !Number.isSafeInteger(item)) throw new Error('Unsafe JSON integer; encode large integers as decimal strings')
    if (item && typeof item === 'object') for (const child of Object.values(item)) check(child)
  }
  check(value)
  return value
}
function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || value.toLowerCase() === zeroAddress) throw new Error(`Missing nonzero ${name}`)
  return getAddress(value)
}
function uint(value: unknown, name: string): bigint {
  if ((typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid ${name}`)
  return BigInt(value as string | number)
}

/** Check both directions of the deployed registry/oracle/treasury seam. */
export async function assertReciprocalBindings(
  expected: { registry: Address; oracle: Address; treasury: Address; token: Address; governance: Address },
  read: (target: Address, functionName: string) => Promise<unknown>,
) {
  const bindings = [
    ['registry.treasury', expected.registry, 'treasury', expected.treasury],
    ['oracle.registry', expected.oracle, 'registry', expected.registry],
    ['oracle.treasury', expected.oracle, 'treasury', expected.treasury],
    ['oracle.usdc', expected.oracle, 'usdc', expected.token],
    ['oracle.governance', expected.oracle, 'governance', expected.governance],
  ] as const
  const actual = await Promise.all(bindings.map(([, target, functionName]) => read(target, functionName)))
  for (let index = 0; index < bindings.length; ++index) {
    if (typeof actual[index] !== 'string' || (actual[index] as string).toLowerCase() !== bindings[index][3].toLowerCase()) {
      throw new Error(`Reciprocal deployment binding mismatch: ${bindings[index][0]}`)
    }
  }
  return Object.fromEntries(bindings.map(([name], index) => [name, actual[index]]))
}

type Artifact = { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex }; metadata: string | Record<string, any> }
export function loadArtifact(name: string, target: string) {
  const path = resolve(OUT, `${name}.sol`, `${name}.json`)
  const bytes = readFileSync(path)
  const artifact = JSON.parse(bytes.toString()) as Artifact
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata
  const settings = metadata.settings
  const targets = Object.entries(settings.compilationTarget ?? {})
  if (targets.length !== 1 || targets[0][1] !== name || resolve(ROOT, 'oracle', targets[0][0]) !== resolve(ROOT, 'oracle', target)
      || !String(metadata.compiler.version).startsWith('0.8.30+') || settings.evmVersion !== 'prague'
      || settings.optimizer?.enabled !== true || settings.optimizer?.runs !== 200) throw new Error(`Wrong pinned artifact: ${name}`)
  for (const code of [artifact.bytecode.object, artifact.deployedBytecode.object]) if (!/^0x[0-9a-fA-F]+$/.test(code) || code.length % 2 !== 0) throw new Error(`Unlinked or empty ${name} bytecode`)
  for (const [sourcePath, source] of Object.entries(metadata.sources ?? {})) {
    const contents = readFileSync(resolve(ROOT, 'oracle', sourcePath))
    const expected = (source as { keccak256: string }).keccak256
    // Git may check out LF-compiled sources as CRLF on Windows. Both encodings
    // must preserve the exact source text; no other whitespace is normalized.
    if (keccak256(toHex(contents)) !== expected && keccak256(stringToHex(contents.toString().replaceAll('\r\n', '\n'))) !== expected) throw new Error(`Stale ${name} artifact; rebuild current sources`)
  }
  if ((artifact.deployedBytecode.object.length - 2) / 2 > 131072) throw new Error(`${name} runtime exceeds Monad size limit`)
  return { ...artifact, path, artifactSha256: sha256(bytes), creationHash: keccak256(artifact.bytecode.object) }
}

export type Artifacts = {
  engine: ReturnType<typeof loadArtifact>; store: ReturnType<typeof loadArtifact>; factory: ReturnType<typeof loadArtifact>;
  registry: ReturnType<typeof loadArtifact>; vault: ReturnType<typeof loadArtifact>; oracle: ReturnType<typeof loadArtifact>;
  rolloverHelper: ReturnType<typeof loadArtifact>
}
export function loadArtifacts(): Artifacts {
  return {
    engine: loadArtifact('RegistryBookRiskEngine', 'src/integration/RegistryBookRiskEngine.sol'),
    store: loadArtifact('EngineCodeStore', '../contracts/src/factory/EngineCodeStore.sol'),
    factory: loadArtifact('MarketFactory', '../contracts/src/factory/MarketFactory.sol'),
    registry: loadArtifact('MarketRegistry', 'src/MarketRegistry.sol'),
    vault: loadArtifact('CollateralVault', '../contracts/src/vaults/CollateralVault.sol'),
    oracle: loadArtifact('ResolutionOracle', 'src/ResolutionOracle.sol'),
    rolloverHelper: loadArtifact('RolloverBatcher', 'src/integration/RolloverBatcher.sol'),
  }
}

export type NetworkSnapshot = {
  chainId: number; blockNumber: bigint; blockHash: Hex; timestamp: bigint; gasPrice: bigint; gasLimit: bigint;
  registry: Address; oracle: Address; token: Address; governance: Address; lister: Address; currentFactory: Address;
  proposer: Address; executor: Address; delay: bigint; proposerAllowed: boolean; executorAllowed: boolean;
  deployerNonce: bigint; reserveBalance: bigint; activeTrustSet: number; checks: Array<{ name: string; passed: boolean; detail?: unknown }>
}
export type UnsignedStep = { name: string; from: Address; to?: Address; data: Hex; value: '0'; waitSeconds?: string; operationId?: Hex; expectedAddress?: Address }

export function buildBundle(config: any, pack: any, network: NetworkSnapshot, artifacts: Artifacts) {
  if (config.schema !== 'eros-integrated-deployment-input/1') throw new Error('Wrong integrated deployment input schema')
  const deployer = address(config.deployer, 'deployer')
  const treasury = address(config.reserveTreasury, 'reserveTreasury')
  const funder = address(config.reserveFunder, 'reserveFunder')
  const reserveAtoms = uint(config.reserveAtoms, 'reserveAtoms')
  if (config.expectedCreationCodeHash?.toLowerCase() !== artifacts.engine.creationHash.toLowerCase()) throw new Error('Creation code hash is not explicitly approved in input')
  if (config.rolloverHelper !== undefined && (config.rolloverHelper === null
      || config.rolloverHelper.expectedCreationCodeHash?.toLowerCase() !== artifacts.rolloverHelper.creationHash.toLowerCase())) {
    throw new Error('Rollover helper creation code hash is not explicitly approved in input')
  }
  if (!network.proposerAllowed || !network.executorAllowed) throw new Error('Supplied Timelock proposer/executor lacks the required onchain role')
  if (network.activeTrustSet === 0) throw new Error('Oracle has no active trust set')
  if (network.reserveBalance < reserveAtoms) throw new Error('Reserve funder lacks the requested collateral; rehearsal never mints or fabricates collateral')
  if (!pack.marketInput || !pack.engineListing || pack.engineInit !== '0x') throw new Error('A complete current listing pack with empty engineInit is required')
  const m = { ...pack.marketInput, ai: { ...pack.marketInput.ai, allowListPtr: zeroAddress },
    uma: { ...pack.marketInput.uma, bondCurrency: network.token, claimTemplatePtr: zeroAddress } }
  const p = pack.engineListing
  if (address(p.engineGovernance ?? p.governance, 'engineGovernance') !== network.governance) throw new Error('Listing governance must match registry governance')
  if (uint(p.deploymentCapX, 'deploymentCapX') > 1n && (!reserveAtoms || !config.riskParams
      || config.riskParams.calibrated !== true || uint(config.riskParams.deploymentCapX, 'profile deploymentCapX') <= 1n
      || uint(config.riskParams.deploymentCapX, 'profile deploymentCapX') > uint(p.deploymentCapX, 'deploymentCapX')
      || !['empirical', 'fixture'].includes(config.calibrationEvidence?.kind)
      || !/^0x[0-9a-fA-F]{64}$/.test(config.calibrationEvidence?.hash ?? '')
      || config.calibrationEvidence.hash.toLowerCase() === zeroHash)) throw new Error('Leveraged listing requires funded reserve, explicit calibrated riskParams and typed calibrationEvidence with content hash')
  if (uint(m.tau, 'tau') < network.timestamp + 86400n + 3n * network.delay) throw new Error('Listing T leaves less than the engine minimum horizon plus governance delays')
  const listing = { ...p, governance: network.governance, token: network.token, marketId: zeroHash, registry: zeroAddress,
    resolutionAuthority: zeroAddress, monitor: zeroAddress, scheduledT: 0n, listedAt: 0n, sourceHash: zeroHash, rulesHash: zeroHash,
    invalidRule: { fallbackListed: false, captureGraceSecs: 0n, fallbackPriceWad: 0n, voidSecs: 0n } }
  const creation = artifacts.engine.bytecode.object
  const first = creation.slice(0, 2 + 200_000) as Hex
  const tail = `0x${creation.slice(2 + 200_000)}` as Hex
  if (tail === '0x' || (tail.length - 2) / 2 >= 131072) throw new Error('Current bundle requires the reviewed two-store engine layout')
  const store = getContractAddress({ from: deployer, nonce: network.deployerNonce })
  const storeTail = getContractAddress({ from: deployer, nonce: network.deployerNonce + 1n })
  const factory = getContractAddress({ from: deployer, nonce: network.deployerNonce + 2n })
  const vault = getContractAddress({ from: factory, nonce: 1n })
  const engine = getContractAddress({ from: factory, nonce: 2n })
  const steps: UnsignedStep[] = []
  const create = (name: string, artifact: Artifact, args: readonly unknown[], expectedAddress: Address) => {
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args })
    if ((data.length - 2) / 2 > 262144) throw new Error(`${name} initcode exceeds Monad limit`)
    steps.push({ name, from: deployer, data, value: '0', expectedAddress })
  }
  create('deploy-code-store', artifacts.store, [first], store)
  create('deploy-code-store-tail', artifacts.store, [tail], storeTail)
  create('deploy-real-factory', artifacts.factory, [network.registry, network.token, treasury, store, storeTail, artifacts.engine.creationHash], factory)
  const rolloverHelper = config.rolloverHelper === undefined ? undefined : {
    address: getContractAddress({ from: deployer, nonce: network.deployerNonce + 3n }),
    codeHash: keccak256(artifacts.rolloverHelper.deployedBytecode.object),
    creationCodeHash: artifacts.rolloverHelper.creationHash,
  }
  if (rolloverHelper) create('deploy-rollover-helper', artifacts.rolloverHelper, [], rolloverHelper.address)
  const call = (name: string, from: Address, to: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    steps.push({ name, from, to, data: encodeFunctionData({ abi, functionName, args }), value: '0' })
  const govern = (name: string, calls: Array<{ to: Address; value: bigint; data: Hex }>) => {
    const salt = keccak256(stringToHex(`${network.chainId}:${network.blockHash}:${deployer}:${network.deployerNonce}:${name}:${artifacts.engine.creationHash}`))
    const execution = encodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[],bytes'), [calls,
      encodeAbiParameters(parseAbiParameters('bytes32,bytes32'), [zeroHash, salt])])
    const operationId = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32'), [MODE, keccak256(execution)]))
    call(`${name}-propose`, network.proposer, network.governance, timelockAbi, 'propose', [MODE, execution, network.delay])
    call(`${name}-execute`, network.executor, network.governance, timelockAbi, 'execute', [MODE, execution])
    Object.assign(steps.at(-1)!, { waitSeconds: network.delay.toString(), operationId })
  }
  const registrySetup = [{ to: network.registry, value: 0n,
    data: encodeFunctionData({ abi: artifacts.registry.abi, functionName: 'setFactory', args: [factory] }) }]
  if (config.globals) registrySetup.push({ to: network.registry, value: 0n,
    data: encodeFunctionData({ abi: artifacts.registry.abi, functionName: 'setGlobals', args: [config.globals] }) })
  govern('authorize-factory', registrySetup)
  const listingData = encodeFunctionData({ abi: artifacts.registry.abi, functionName: 'createMarket', args: [m, listing, '0x'] })
  if (network.lister === network.governance) govern('list-market', [{ to: network.registry, value: 0n, data: listingData }])
  else steps.push({ name: 'list-market', from: network.lister, to: network.registry, data: listingData, value: '0' })
  if (reserveAtoms > 0n) {
    call('approve-reserve-collateral', funder, network.token, tokenAbi, 'approve', [vault, reserveAtoms])
    call('deposit-reserve-collateral', funder, vault, artifacts.vault.abi, 'deposit', [reserveAtoms])
    call('allocate-reserve-before-activation', funder, vault, artifacts.vault.abi, 'allocate', [engine, reserveAtoms, true])
  }
  const activation = []
  if (config.riskParams) activation.push({ to: engine, value: 0n,
    data: encodeFunctionData({ abi: artifacts.engine.abi, functionName: 'stageRiskParams', args: [config.riskParams] }) })
  activation.push({ to: engine, value: 0n, data: encodeFunctionData({ abi: artifacts.engine.abi, functionName: 'activateMarket' }) })
  govern('calibrate-and-activate', activation)
  return { schema: 'eros-integrated-unsigned-bundle/1', chainId: network.chainId, broadcast: false, publicTransactions: 0,
    stateBlock: network.blockNumber, stateBlockHash: network.blockHash, deployerNonce: network.deployerNonce,
    expectedCreationCodeHash: artifacts.engine.creationHash, calibrationEvidence: config.calibrationEvidence ?? 'uncalibrated full-backing only',
    predicted: { store, storeTail, factory, vault, engine }, ...(rolloverHelper ? { rolloverHelper } : {}), marketId: m.marketId, reserveAtoms, steps,
    limitations: ['Predicted addresses are not deployment evidence; rebuild if nonce, input or registry state changes.',
      'Activation alone does not establish live leverage: signed INDEX, executable liquidity, calibration and complete PERP/BASIS history are still required.'] }
}

export async function main() {
  const [mode, manifestPath, output, configPath] = process.argv.slice(2)
  if (!['inspect', 'rehearse-local'].includes(mode) || !manifestPath || !output) throw new Error('Usage: prepare-integrated.ts <inspect|rehearse-local> <deployments.json> <report.json> [input.json]')
  const relativeOutput = relative(resolve(ROOT, 'tmp'), resolve(output))
  if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput) || !output.endsWith('.json')
      || [manifestPath, configPath].filter(Boolean).some(input => resolve(input!) === resolve(output))) throw new Error('Report must be a distinct JSON file inside repository tmp/')
  const endpoint = process.env.INTEGRATED_PREFLIGHT_RPC
  if (!endpoint) throw new Error('INTEGRATED_PREFLIGHT_RPC is required')
  const report: any = { schema: 'eros-integrated-preflight/1', mode, broadcast: false, publicTransactions: 0, passed: false,
    publicBroadcast: false, readyForPublicActivation: false, localTransactions: 0,
    source: 'current integrated two-store factory', checks: [], blockers: [], artifacts: {} }
  const write = () => { mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, json(report) + '\n') }
  try {
    const deploymentBytes = readFileSync(manifestPath)
    // Legacy local manifests contain large WAD numbers in market summaries.
    // They are not used to prepare transactions: only explicit exact input/pack
    // quantities are. The sole numeric manifest field consumed here is chainId.
    const manifest = JSON.parse(deploymentBytes.toString())
    if (!Number.isSafeInteger(manifest.chainId)) throw new Error('Invalid manifest chainId')
    report.deploymentManifestSha256 = sha256(deploymentBytes)
    const config = configPath ? exactJson(readFileSync(configPath, 'utf8')) : undefined
    const rpc = rpcTransport(endpoint, mode === 'rehearse-local')
    const client = createPublicClient({ transport: custom(rpc), cacheTime: 0 })
    const [chainId, version, block, gasPrice] = await Promise.all([client.getChainId(), rpc.request({ method: 'web3_clientVersion' }), client.getBlock(), client.getGasPrice()])
    if (![31337, 10143].includes(chainId) || chainId !== manifest.chainId) throw new Error('RPC must match the local or Monad-testnet manifest chain')
    let forkSource: { endpoint: string; block: bigint } | undefined
    if (mode === 'rehearse-local') {
      rpc.verifyLocal(version)
      const nodeInfo = await rpc.request({ method: 'anvil_nodeInfo' })
      if (nodeInfo.network !== 'monad' || nodeInfo.hardFork !== 'MonadTen') throw new Error('Rehearsal requires Monad network and MonadTen hardfork')
      report.localNode = { network: nodeInfo.network, hardfork: nodeInfo.hardFork }
      if (nodeInfo.forkConfig?.forkUrl) {
        forkSource = { endpoint: nodeInfo.forkConfig.forkUrl, block: BigInt(nodeInfo.forkConfig.forkBlockNumber) }
        if (block.number !== forkSource.block) throw new Error('Use a clean fork at its pinned source block for deployment rehearsal')
        const sourceRpc = rpcTransport(forkSource.endpoint)
        const [sourceChainId, sourceBlock] = await Promise.all([
          sourceRpc.request({ method: 'eth_chainId' }),
          sourceRpc.request({ method: 'eth_getBlockByNumber', params: [toHex(forkSource.block), false] }),
        ])
        if (BigInt(sourceChainId) !== BigInt(chainId) || sourceBlock?.hash !== block.hash) throw new Error('Fork source chain/block identity mismatch')
        report.forkSource = { rpcOrigin: new URL(forkSource.endpoint).origin, rpcEndpointSha256: sha256(forkSource.endpoint),
          chainId, blockNumber: forkSource.block, blockHash: sourceBlock.hash, readOnlyVerified: true }
      }
    }
    report.chainId = chainId
    report.block = { number: block.number, hash: block.hash, timestamp: block.timestamp }
    report.rpcOrigin = new URL(endpoint).origin
    report.rpcEndpointSha256 = sha256(endpoint)
    report.clientVersion = version
    const artifacts = loadArtifacts()
    report.artifacts = Object.fromEntries(Object.entries(artifacts).map(([name, artifact]) => [name, {
      sha256: artifact.artifactSha256, creationCodeHash: artifact.creationHash, runtimeBytes: (artifact.deployedBytecode.object.length - 2) / 2 }]))
    const registry = address(manifest.contracts.MarketRegistry.address, 'registry')
    const oracle = address(manifest.contracts.ResolutionOracle.address, 'oracle')
    const governance = address(manifest.contracts.Timelock.address, 'governance')
    const token = address(manifest.usdc, 'collateral token')
    const treasury = address(manifest.contracts.BondTreasury.address, 'bondTreasury')
    const read = (target: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address: target, abi, functionName, args, blockNumber: block.number })
    const checks: NetworkSnapshot['checks'] = []
    for (const [name, raw] of Object.entries(manifest.contracts)) {
      const contract = raw as { address: Address; codehash: Hex }
      const code = await client.getCode({ address: contract.address, blockNumber: block.number })
      checks.push({ name: `${name} runtime`, passed: !!code && code !== '0x' && keccak256(code).toLowerCase() === contract.codehash.toLowerCase() })
    }
    const [boundOracle, boundToken, boundGov, listerRaw, factoryRaw, activeTrustSet, delay, globals, commitment, assertionBalance] = await Promise.all([
      read(registry, artifacts.registry.abi, 'oracle'), read(registry, artifacts.registry.abi, 'usdc'), read(registry, artifacts.registry.abi, 'governance'),
      read(registry, artifacts.registry.abi, 'lister'), read(registry, artifacts.registry.abi, 'factory'), read(oracle, artifacts.oracle.abi, 'activeTrustSetId'),
      read(governance, timelockAbi, 'minDelay'), read(registry, artifacts.registry.abi, 'globals'),
      read(address(manifest.contracts.BondTreasury.address, 'bondTreasury'), parseAbi(['function totalCommitted() view returns (uint256)']), 'totalCommitted'),
      read(address(manifest.contracts.BondTreasury.address, 'bondTreasury'), parseAbi(['function balanceOf(uint8) view returns (uint256)']), 'balanceOf', [0]),
    ])
    checks.push({ name: 'registry oracle/token/governance bindings', passed: String(boundOracle).toLowerCase() === oracle.toLowerCase()
      && String(boundToken).toLowerCase() === token.toLowerCase() && String(boundGov).toLowerCase() === governance.toLowerCase() })
    checks.push({ name: 'active oracle trust set', passed: Number(activeTrustSet) > 0, detail: activeTrustSet })
    checks.push({ name: 'current assertion commitments funded', passed: BigInt(assertionBalance as bigint) >= BigInt(commitment as bigint), detail: { assertionBalance, commitment } })
    const treasuryAbi = parseAbi(['function registry() view returns (address)', 'function oracle() view returns (address)',
      'function usdc() view returns (address)', 'function governance() view returns (address)', 'function maxPerMarket() view returns (uint256)'])
    const [treasuryRegistry, treasuryOracle, treasuryToken, treasuryGov, maxPerMarket, trustSet, tokenCode, tokenDecimals] = await Promise.all([
      read(treasury, treasuryAbi, 'registry'), read(treasury, treasuryAbi, 'oracle'), read(treasury, treasuryAbi, 'usdc'),
      read(treasury, treasuryAbi, 'governance'), read(treasury, treasuryAbi, 'maxPerMarket'),
      read(oracle, artifacts.oracle.abi, 'trustSet', [activeTrustSet]), client.getCode({ address: token, blockNumber: block.number }),
      read(token, tokenAbi, 'decimals'),
    ])
    checks.push({ name: 'treasury registry/oracle/token/governance bindings', passed:
      [treasuryRegistry, treasuryOracle, treasuryToken, treasuryGov].every((actual, i) => String(actual).toLowerCase() === [registry, oracle, token, governance][i].toLowerCase()) })
    const reciprocalCheck: NetworkSnapshot['checks'][number] = { name: 'registry treasury and reciprocal oracle bindings', passed: false }
    checks.push(reciprocalCheck)
    report.checks = checks
    reciprocalCheck.detail = await assertReciprocalBindings({ registry, oracle, treasury, token, governance },
      (target, functionName) => read(target, target === registry ? artifacts.registry.abi : artifacts.oracle.abi, functionName))
    reciprocalCheck.passed = true
    checks.push({ name: 'collateral contract exists', passed: !!tokenCode && tokenCode !== '0x' })
    checks.push({ name: 'collateral uses six decimal atoms', passed: Number(tokenDecimals) === 6 })
    report.collateral = { address: token, decimals: tokenDecimals, codehash: tokenCode ? keccak256(tokenCode) : null }
    report.oracleTrustSet = trustSet
    report.assertionFunding = { balanceAtoms: assertionBalance, committedAtoms: commitment, maxPerMarket }
    if (!(trustSet as { cfg: { production: boolean } }).cfg.production) report.blockers.push('Active oracle trust set uses simulation forwarding; production CRE delivery is not verified.')
    const lister = address(listerRaw, 'current lister')
    checks.push({ name: 'manifest lister binding', passed: !manifest.roles?.lister || lister.toLowerCase() === String(manifest.roles.lister).toLowerCase() })
    report.currentFactory = factoryRaw
    report.globals = globals
    report.checks = checks
    if (checks.some(check => !check.passed)) throw new Error('Existing deployment identity or configuration check failed')
    if (!config) {
      report.blockers.push('Supply a reviewed deployment input/listing pack, deployer/proposer/executor, reserve funder and calibration to prepare exact transactions.')
      report.status = 'existing-stack-verified-inputs-required'
    } else {
      const deployer = address(config.deployer, 'deployer')
      const proposer = address(config.proposer ?? manifest.roles?.teamSafe, 'proposer')
      const executor = address(config.executor ?? config.deployer, 'executor')
      const funder = address(config.reserveFunder, 'reserveFunder')
      const [nonce, pendingNonce, reserveBalance, proposerAllowed, executorAllowed, openExecution] = await Promise.all([
        client.getTransactionCount({ address: deployer, blockNumber: block.number }), client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
        read(token, tokenAbi, 'balanceOf', [funder]), read(governance, timelockAbi, 'hasRole', [proposer, 1n]),
        read(governance, timelockAbi, 'hasRole', [executor, 2n]), read(governance, timelockAbi, 'hasRole', [OPEN_ROLE, 2n]),
      ])
      if (nonce !== pendingNonce) throw new Error('Deployer has pending transactions; predicted CREATE addresses are ambiguous')
      if (forkSource) {
        const sourceRpc = rpcTransport(forkSource.endpoint)
        const [sourceNonce, sourceReserveBalance] = await Promise.all([
          sourceRpc.request({ method: 'eth_getTransactionCount', params: [deployer, toHex(forkSource.block)] }),
          sourceRpc.request({ method: 'eth_call', params: [{ to: token,
            data: encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [funder] }) }, toHex(forkSource.block)] }),
        ])
        if (BigInt(sourceNonce) !== BigInt(nonce) || BigInt(sourceReserveBalance) !== BigInt(reserveBalance as bigint)) throw new Error('Fork nonce or collateral balance differs from its recorded source state')
        report.forkSource.collateralBalanceVerified = true
        report.forkSource.deployerNonceVerified = true
      }
      const network: NetworkSnapshot = { chainId, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp,
        gasPrice, gasLimit: block.gasLimit, registry, oracle, token, governance, lister, currentFactory: factoryRaw as Address,
        proposer, executor, delay: delay as bigint, proposerAllowed: proposerAllowed as boolean, executorAllowed: !!executorAllowed || !!openExecution,
        deployerNonce: BigInt(nonce), reserveBalance: reserveBalance as bigint, activeTrustSet: Number(activeTrustSet), checks }
      const packPath = resolve(dirname(resolve(configPath!)), config.listingPack)
      const packBytes = readFileSync(packPath)
      const pack = exactJson(packBytes.toString())
      report.inputSha256 = sha256(readFileSync(configPath!))
      report.listingPackSha256 = sha256(packBytes)
      report.reserve = { funder, balanceAtoms: reserveBalance, requiredAtoms: uint(config.reserveAtoms, 'reserveAtoms') }
      const bundle = buildBundle(config, pack, network, artifacts)
      report.bundle = bundle
      report.roles = await Promise.all([...new Set(bundle.steps.map(step => step.from))].map(async owner => ({ address: owner,
        nativeBalance: await client.getBalance({ address: owner, blockNumber: block.number }) })))
      report.status = 'unsigned-bundle-prepared'
      report.blockers.push('Unsigned preparation is not sequential state simulation. Rehearse the bundle on a disposable fork before public broadcast.',
        'Onchain role membership does not prove local signing custody. No keys are loaded by this command.',
        'Continuous source publication, operator runtime/gas enrollment and frontend connection remain separate checks.')
      if (config.calibrationEvidence?.kind === 'fixture') report.blockers.push('This unsigned diagnostic uses fixture calibration; reviewed market/source inputs and empirical calibration are required before public activation.')
      if (mode === 'rehearse-local') {
        const snapshotId = await rpc.request({ method: 'evm_snapshot' })
        const receipts: unknown[] = []
        report.localGasFunding = 'Only native balances of impersonated local senders are topped up; token balances are unchanged.'
        try {
          for (const step of bundle.steps) {
            if (step.operationId) {
              // Use latest state, not the original inspection block, for the proposed operation.
              const actualReady = await client.readContract({ address: governance, abi: timelockAbi, functionName: 'readyTimestamp', args: [step.operationId] })
              const latest = await client.getBlock()
              if (actualReady === 0n) throw new Error(`Timelock operation was not proposed: ${step.name}`)
              if (actualReady > latest.timestamp) {
                await rpc.request({ method: 'evm_increaseTime', params: [Number(actualReady - latest.timestamp)] })
                await rpc.request({ method: 'evm_mine' })
              }
            }
            await rpc.request({ method: 'anvil_impersonateAccount', params: [step.from] })
            try {
              await rpc.request({ method: 'anvil_setBalance', params: [step.from, toHex(10n ** 22n)] })
              const transaction = { from: step.from, ...(step.to ? { to: step.to } : {}), data: step.data, value: '0x0' }
              const estimate = BigInt(await rpc.request({ method: 'eth_estimateGas', params: [{ ...transaction, gas: toHex(MAX_GAS) }] }))
              const gas = (estimate * 105n + 99n) / 100n + 10_000n
              if (gas > MAX_GAS) throw new Error(`${step.name} measured gas plus margin exceeds the 30M transaction limit`)
              const hash = await rpc.request({ method: 'eth_sendTransaction', params: [{ ...transaction, gas: toHex(gas) }] }) as Hex
              report.broadcast = true
              report.localTransactions++
              let receipt: any
              for (let attempt = 0; attempt < 100; ++attempt) {
                receipt = await rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] })
                if (receipt) break
                await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
              }
              if (!receipt || receipt.status !== '0x1') throw new Error(`Local rehearsal transaction failed: ${step.name}`)
              if (step.expectedAddress && receipt.contractAddress?.toLowerCase() !== step.expectedAddress.toLowerCase()) throw new Error('Predicted CREATE address changed')
              const canonical = await client.getBlock({ blockNumber: BigInt(receipt.blockNumber) })
              if (canonical.hash !== receipt.blockHash) throw new Error('Rehearsal receipt is not canonical')
              receipts.push({ name: step.name, hash, estimate, gasLimit: gas, receipt })
              report.rehearsalReceipts = receipts
              write()
            } finally { await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [step.from] }) }
          }
          const engine = bundle.predicted.engine
          const [liveFactory, engineCode, liveVault, seed, active, market, engineListing, listingHash, activeProfile,
            storeCode, tailCode, factoryEngine, vaultEngine] = await Promise.all([
            client.readContract({ address: registry, abi: artifacts.registry.abi, functionName: 'factory' }), client.getCode({ address: engine }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'collateralVault' }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'reserveCapBaseQ' }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'active' }),
            client.readContract({ address: registry, abi: artifacts.registry.abi, functionName: 'getMarketCore', args: [bundle.marketId] }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'listing' }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'listingHash' }),
            client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'activeProfile' }),
            client.getCode({ address: bundle.predicted.store }), client.getCode({ address: bundle.predicted.storeTail }),
            client.readContract({ address: bundle.predicted.factory, abi: artifacts.factory.abi, functionName: 'engineOf', args: [bundle.marketId] }),
            client.readContract({ address: bundle.predicted.vault, abi: artifacts.vault.abi, functionName: 'engines', args: [engine] }),
          ])
          const listing = engineListing as { registry: Address; resolutionAuthority: Address; token: Address; governance: Address }
          if (String(liveFactory).toLowerCase() !== bundle.predicted.factory.toLowerCase() || !engineCode || engineCode === '0x'
              || String(liveVault).toLowerCase() !== bundle.predicted.vault.toLowerCase() || !active
              || (market as { engine: string }).engine.toLowerCase() !== engine.toLowerCase()
              || String(factoryEngine).toLowerCase() !== engine.toLowerCase() || !vaultEngine
              || [listing.registry, listing.resolutionAuthority, listing.token, listing.governance].some((actual, i) => actual.toLowerCase() !== [registry, oracle, token, governance][i].toLowerCase())
              || !storeCode || !tailCode || !storeCode.startsWith('0x00') || !tailCode.startsWith('0x00')
              || keccak256(`0x${storeCode.slice(4)}${tailCode.slice(4)}`) !== bundle.expectedCreationCodeHash
              || BigInt(seed as bigint) !== bundle.reserveAtoms * 10n ** 18n) throw new Error('Rehearsed engine/vault/registry/reserve binding mismatch')
          if (config.riskParams) {
            const expectedProfile = await client.readContract({ address: engine, abi: artifacts.engine.abi, functionName: 'profileHashOf', args: [config.riskParams] })
            if ((activeProfile as { profileHash: Hex }).profileHash !== expectedProfile) throw new Error('Staged risk profile did not become active')
          }
          if (bundle.rolloverHelper) {
            const helperCode = await client.getCode({ address: bundle.rolloverHelper.address })
            if (!helperCode || keccak256(helperCode) !== bundle.rolloverHelper.codeHash) throw new Error('Rehearsed rollover helper runtime mismatch')
          }
          report.rehearsal = { passed: true, engineCodehash: keccak256(engineCode), listingHash, activeProfile, reserveCapBaseQ: seed, active,
            ...(bundle.rolloverHelper ? { rolloverHelper: bundle.rolloverHelper } : {}),
            deploymentEvidenceScope: 'ephemeral local fork; addresses are not a deployed public/frontend manifest',
            localOnly: true, roleCustodyVerified: false }
          report.status = 'local-deployment-rehearsed'
          report.blockers = report.blockers.filter((item: string) => !item.startsWith('Unsigned preparation'))
          report.passed = true
        } finally {
          report.localStateRestored = await rpc.request({ method: 'evm_revert', params: [snapshotId] })
          if (!report.localStateRestored) throw new Error('Failed to restore the local rehearsal snapshot')
        }
      }
    }
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Inspection block changed')
  } catch (error) {
    report.passed = false
    report.error = error instanceof Error ? error.message.replaceAll(endpoint, '[redacted]') : 'Integrated preflight failed'
    report.status = 'failed'
  }
  write()
  console.log(json({ status: report.status, passed: report.passed, publicTransactions: 0, output: resolve(output), error: report.error }))
  if (report.status === 'failed') process.exitCode = 1
}

if (import.meta.main) await main()
