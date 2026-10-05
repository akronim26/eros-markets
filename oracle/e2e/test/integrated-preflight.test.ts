import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeAbiParameters, decodeFunctionData, getContractAddress, keccak256, parseAbi, parseAbiParameters, zeroHash, type Address, type Hex } from 'viem'
import { assertLoopback, assertReciprocalBindings, buildBundle, exactJson, loadArtifacts, rpcTransport, type NetworkSnapshot } from '../src/integrated-preflight.js'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const artifacts = loadArtifacts()
const network: NetworkSnapshot = {
  chainId: 31337, blockNumber: 123n, blockHash: zeroHash, timestamp: 1_800_000_000n, gasPrice: 1n, gasLimit: 200_000_000n,
  registry: address(1), oracle: address(2), token: address(3), governance: address(4), lister: address(5), currentFactory: address(6),
  proposer: address(7), executor: address(8), delay: 3600n, proposerAllowed: true, executorAllowed: true, deployerNonce: 10n,
  reserveBalance: 100_000_000n, activeTrustSet: 1, checks: [],
}
function fixture() {
  // Historical example is only a schema seed. Large quantities and timings are
  // explicitly replaced, so this never approves its stale stub-engine values.
  const pack = JSON.parse(readFileSync(new URL('../../listings/example/pack.json', import.meta.url), 'utf8'))
  pack.engineInit = '0x'
  pack.marketInput.tau = (network.timestamp + 2n * 86400n).toString()
  pack.engineListing.engineGovernance = network.governance
  pack.engineListing.maxSpreadWad = '50000000000000000'
  pack.engineListing.bootstrapBandWad = '50000000000000000'
  const config = { schema: 'eros-integrated-deployment-input/1', deployer: address(9), reserveTreasury: address(10),
    reserveFunder: address(11), reserveAtoms: '100000000', expectedCreationCodeHash: artifacts.engine.creationHash }
  return { pack, config }
}

describe('integrated deployment preparation boundary', () => {
  test('public transport rejects every signing, broadcasting and state mutation method before network access', async () => {
    const transport = rpcTransport('https://example.invalid')
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTransaction',
      'anvil_impersonateAccount', 'anvil_setBalance', 'evm_snapshot', 'evm_revert', 'evm_increaseTime']) {
      await expect(transport.request({ method })).rejects.toThrow('RPC method forbidden')
    }
    expect(() => transport.verifyLocal('anvil')).toThrow('requires Anvil')
  })
  test('rehearsal requires explicit loopback HTTP and positively identified Anvil', async () => {
    for (const endpoint of ['https://127.0.0.1:8545', 'http://testnet-rpc.monad.xyz', 'http://127.0.0.1@evil.test',
      'http://127.0.0.1:8545/proxy', 'http://localhost?rpc=public', 'http://localhost#public']) expect(() => assertLoopback(endpoint)).toThrow()
    for (const endpoint of ['http://localhost:8545', 'http://127.0.0.1:8545/', 'http://[::1]:8545']) expect(() => assertLoopback(endpoint)).not.toThrow()
    const transport = rpcTransport('http://127.0.0.1:1', true)
    await expect(transport.request({ method: 'eth_sendTransaction' })).rejects.toThrow('forbidden')
    expect(() => transport.verifyLocal('Geth/v1')).toThrow('requires Anvil')
  })
  test('JSON parsing refuses lossy numeric inputs', () => {
    expect(() => exactJson('{"risk":{"wad":1000000000000000001}}')).toThrow('Unsafe JSON integer')
    expect(exactJson('{"risk":{"wad":"1000000000000000001"}}').risk.wad).toBe('1000000000000000001')
  })
})

describe('reciprocal deployed-contract identity', () => {
  const expected = { registry: network.registry, oracle: network.oracle, treasury: address(12),
    token: network.token, governance: network.governance }
  const values = {
    [`${expected.registry}:treasury`]: expected.treasury,
    [`${expected.oracle}:registry`]: expected.registry,
    [`${expected.oracle}:treasury`]: expected.treasury,
    [`${expected.oracle}:usdc`]: expected.token,
    [`${expected.oracle}:governance`]: expected.governance,
  }
  test('reads each binding from the actual registry/oracle and accepts matching addresses', async () => {
    const calls: string[] = []
    const bindings = await assertReciprocalBindings(expected, async (target, name) => {
      const key = `${target}:${name}`
      calls.push(key)
      return values[key]?.toUpperCase()
    })
    expect(calls.sort()).toEqual(Object.keys(values).sort())
    expect(Object.keys(bindings)).toHaveLength(5)
  })
  test.each([
    ['registry.treasury', expected.registry, 'treasury'],
    ['oracle.registry', expected.oracle, 'registry'],
    ['oracle.treasury', expected.oracle, 'treasury'],
    ['oracle.usdc', expected.oracle, 'usdc'],
    ['oracle.governance', expected.oracle, 'governance'],
  ] as const)('rejects mismatched %s before preparing a bundle', async (label, target, name) => {
    const mismatch = { ...values, [`${target}:${name}`]: address(99) }
    await expect(assertReciprocalBindings(expected, async (actualTarget, actualName) =>
      mismatch[`${actualTarget}:${actualName}`])).rejects.toThrow(`Reciprocal deployment binding mismatch: ${label}`)
  })
})

describe('exact factory/governance/reserve transaction bundle', () => {
  test('optional reviewed helper adds exactly one deployment without changing factory children or legacy steps', () => {
    const { config, pack } = fixture()
    const legacy = buildBundle(config, pack, network, artifacts)
    expect(legacy).not.toHaveProperty('rolloverHelper')
    const bundle = buildBundle({ ...config, rolloverHelper: { expectedCreationCodeHash: artifacts.rolloverHelper.creationHash } }, pack, network, artifacts)
    expect(bundle.steps).toHaveLength(legacy.steps.length + 1)
    expect(bundle.steps.filter(step => step.name !== 'deploy-rollover-helper')).toEqual(legacy.steps)
    expect(bundle.predicted).toEqual(legacy.predicted)
    expect(bundle.rolloverHelper?.address).toBe(getContractAddress({ from: config.deployer, nonce: 13n }))
    expect(bundle.rolloverHelper?.codeHash).toBe(keccak256(artifacts.rolloverHelper.deployedBytecode.object))
    expect(bundle.steps[3].data).toBe(artifacts.rolloverHelper.bytecode.object)
  })
  test('helper enrollment refuses absent or mismatched explicit creation hash', () => {
    const { config, pack } = fixture()
    for (const rolloverHelper of [null, {}, { expectedCreationCodeHash: zeroHash }]) {
      expect(() => buildBundle({ ...config, rolloverHelper }, pack, network, artifacts)).toThrow('helper creation code hash')
    }
  })
  test('reconstructs the pinned creation code from both stores and predicts CREATE addresses', () => {
    const { config, pack } = fixture()
    const bundle = buildBundle(config, pack, network, artifacts)
    const chunks = bundle.steps.slice(0, 2).map(step => decodeAbiParameters(parseAbiParameters('bytes'),
      `0x${step.data.slice(artifacts.store.bytecode.object.length)}` as Hex)[0])
    expect(keccak256(`${chunks[0]}${chunks[1].slice(2)}` as Hex)).toBe(artifacts.engine.creationHash)
    expect(bundle.predicted.factory).toBe(getContractAddress({ from: config.deployer, nonce: 12n }))
    expect(bundle.predicted.vault).toBe(getContractAddress({ from: bundle.predicted.factory, nonce: 1n }))
    expect(bundle.predicted.engine).toBe(getContractAddress({ from: bundle.predicted.factory, nonce: 2n }))
    expect(bundle.steps[2].data.length / 2).toBeLessThan(262144)
    expect(bundle.publicTransactions).toBe(0)
  })
  test('funds the predicted engine before governed activation and binds real registry/token', () => {
    const { config, pack } = fixture()
    const bundle = buildBundle(config, pack, network, artifacts)
    const list = bundle.steps.find(step => step.name === 'list-market')!
    const decoded = decodeFunctionData({ abi: artifacts.registry.abi, data: list.data }) as any
    expect(list.from).toBe(network.lister)
    expect(decoded.functionName).toBe('createMarket')
    expect(decoded.args[0].uma.bondCurrency).toBe(network.token)
    expect(decoded.args[1].governance).toBe(network.governance)
    expect(decoded.args[1].token).toBe(network.token)
    expect(decoded.args[2]).toBe('0x')
    const names = bundle.steps.map(step => step.name)
    expect(names.indexOf('allocate-reserve-before-activation')).toBeLessThan(names.indexOf('calibrate-and-activate-propose'))
    const allocation = bundle.steps.find(step => step.name === 'allocate-reserve-before-activation')!
    expect(decodeFunctionData({ abi: artifacts.vault.abi, data: allocation.data }).args).toEqual([bundle.predicted.engine, 100_000_000n, true])
  })
  test('wraps governance-owned listing in a delayed Timelock operation', () => {
    const { config, pack } = fixture()
    const bundle = buildBundle(config, pack, { ...network, lister: network.governance }, artifacts)
    const propose = bundle.steps.find(step => step.name === 'list-market-propose')!
    const execute = bundle.steps.find(step => step.name === 'list-market-execute')!
    expect(propose.from).toBe(network.proposer)
    expect(execute.from).toBe(network.executor)
    expect(execute.waitSeconds).toBe('3600')
    const abi = parseAbi(['function execute(bytes32,bytes) payable'])
    const args = decodeFunctionData({ abi, data: execute.data }).args!
    const calls = decodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[],bytes'), args[1])[0]
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(network.registry)
    expect(decodeFunctionData({ abi: artifacts.registry.abi, data: calls[0].data }).functionName).toBe('createMarket')
  })
  test('refuses unfunded reserves, missing roles, hash drift, inadequate horizon and stale stub init', () => {
    const { config, pack } = fixture()
    expect(() => buildBundle(config, pack, { ...network, reserveBalance: 1n }, artifacts)).toThrow('lacks the requested collateral')
    expect(() => buildBundle(config, pack, { ...network, proposerAllowed: false }, artifacts)).toThrow('role')
    expect(() => buildBundle({ ...config, expectedCreationCodeHash: zeroHash }, pack, network, artifacts)).toThrow('Creation code hash')
    expect(() => buildBundle(config, { ...pack, marketInput: { ...pack.marketInput, tau: Number(network.timestamp) + 86400 } }, network, artifacts)).toThrow('minimum horizon')
    expect(() => buildBundle(config, { ...pack, engineInit: '0x01' }, network, artifacts)).toThrow('empty engineInit')
  })
  test('leveraged input cannot reuse an unfunded, uncalibrated 1x setup', () => {
    const { config, pack } = fixture()
    pack.engineListing.deploymentCapX = 5
    expect(() => buildBundle(config, pack, network, artifacts)).toThrow('typed calibrationEvidence')
    expect(() => buildBundle({ ...config, reserveAtoms: '0', riskParams: {}, calibrationEvidence: { kind: 'fixture', hash: zeroHash } }, pack, network, artifacts)).toThrow('funded reserve')
  })
})
