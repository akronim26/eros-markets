// Run after the default (legacy UMA) and integration (current engine) builds.
import { expect, test } from 'bun:test'
import { decodeDeployData, decodeFunctionData, getContractAddress, zeroAddress, zeroHash } from 'viem'
import { artifact, buildBasePlan, paddedGas, runtimeMatches } from '../src/fresh-testnet'

const deployer = '0x1111111111111111111111111111111111111111'
const roles = Object.fromEntries(['RUNNER_ATTESTOR','COMMITTEE_1','COMMITTEE_2','COMMITTEE_3','WATCHDOG','SIM_RELAYER']
  .map((name, i) => [name, `0x${(i + 2).toString(16).padStart(40,'0')}`])) as Record<string, `0x${string}`>
const plan = buildBasePlan(deployer, 23, roles, { forwarder: deployer, codehash: zeroHash })

test('fresh base uses contiguous nonces and verifies each predicted CREATE identity', () => {
  plan.steps.forEach((step, index) => {
    expect(step.nonce).toBe(23 + index)
    if (step.expectedAddress) expect(step.expectedAddress).toBe(getContractAddress({ from: deployer, nonce: BigInt(step.nonce) }))
  })
  expect(plan.addresses.StubMarketFactory).toBeUndefined()
  expect(plan.addresses.MockUSDC).toBeUndefined()
  expect(plan.addresses.MarketFactory).toBeDefined()
})

test('oracle and registry constructors bind the fresh reciprocal identities', () => {
  const decode = (name: string) => {
    const step = plan.steps.find(s => s.name === `deploy:${name}`)!
    return decodeDeployData({ abi: artifact(name).abi, bytecode: artifact(name).bytecode.object, data: step.data }).args
  }
  expect(decode('BondTreasury')).toEqual([plan.addresses.TestUSDC, plan.addresses.ResolutionOracle, plan.addresses.MarketRegistry, plan.addresses.Timelock])
  expect(decode('MarketRegistry')).toEqual([plan.addresses.ResolutionOracle, plan.addresses.BondTreasury, zeroAddress, plan.addresses.TestUSDC, plan.addresses.Timelock, deployer])
})

test('timelock has bounded delay, explicit key ownership and no open executor', () => {
  const step = plan.steps.find(s => s.name === 'governance:initialize')!
  const decoded = decodeFunctionData({ abi: artifact('Timelock').abi, data: step.data })
  expect(decoded.args).toEqual([300n, zeroAddress, [deployer], [deployer], [deployer]])
  expect(plan.steps.find(s => s.name === 'governance:execute-base')!.waitSeconds).toBe(300)
})

test('gas padding refuses transactions without room under Monad transaction limit', () => {
  expect(paddedGas(1_000_000n)).toBe(1_110_000n)
  expect(() => paddedGas(29_000_000n)).toThrow('GAS_MARGIN_EXCEEDS_30M')
})

test('runtime comparison only ignores compiler-declared immutable bytes', () => {
  const compiled = { object: '0x600000ff' as const, immutableReferences: { '1': [{ start: 1, length: 2 }] } }
  expect(runtimeMatches('0x60abcdff', compiled)).toBe(true)
  expect(runtimeMatches('0x61abcdff', compiled)).toBe(false)
  expect(runtimeMatches('0x60abcd', compiled)).toBe(false)
})
