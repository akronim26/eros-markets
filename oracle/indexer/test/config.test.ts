// Default runtime config and handler filters share the frontend's current verified deployment.
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { OWN } from '../src/addresses'
import { checkCurrentConfig } from '../scripts/current-config.mjs'
import { AFTER_REPLAY_BLOCK, fixtureAddress, simulateItems, TESTNET } from './replay'

const ROOT = new URL('../../', import.meta.url).pathname
const D = JSON.parse(readFileSync(`${ROOT}../frontend/src/config/public-manifest.json`, 'utf8'))
const config = parse(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8'))
const chain = config.chains.find((c: { id: number }) => c.id === 10143)
const source = (name: string) => chain.contracts.find((c: { name: string }) => c.name === name)
const lower = (a: string | string[]) => (Array.isArray(a) ? a : [a]).map((x) => x.toLowerCase())

describe('testnet config', () => {
  it('the oracle’s contracts at their deployed addresses, from the deploy block', () => {
    for (const name of ['ResolutionOracle', 'MarketRegistry', 'BondTreasury', 'UmaAdapter']) {
      expect(lower(source(name).address)).toEqual([D.contracts[name].address.toLowerCase()])
      expect(source(name).start_block).toBe(D.contracts[name].deployBlock)
    }
  })

  it('OOv3, the sandbox DVM, current engines and shared simulation forwarder are selected', () => {
    expect(lower(source('OptimisticOracleV3').address)).toEqual([D.contracts.OptimisticOracleV3.address.toLowerCase()])
    expect(lower(source('ErosSandboxOracle').address)).toEqual([D.contracts.ErosSandboxOracle.address.toLowerCase()])
    expect(lower(source('KeystoneForwarder').address)).toEqual(['0xb9f79d863261869b234c481d1f9a7af84aead192'])
    expect(lower(source('TradingEngine').address)).toEqual(D.markets.map((m: { engine: string }) => m.engine.toLowerCase()))
    // deployed before the oracle (DeployUmaSandbox runs first); nothing is missed from the chain start block
    for (const n of ['OptimisticOracleV3', 'ErosSandboxOracle']) expect(source(n).start_block).toBeLessThan(D.contracts.ResolutionOracle.deployBlock)
    expect(chain.start_block).toBeLessThanOrEqual(Math.min(...chain.contracts.map((c: { start_block: number }) => c.start_block)))
  })

  it('both default and fresh configs pass the startup manifest consistency guard', () => {
    expect(() => checkCurrentConfig()).not.toThrow()
  })

  it('the handlers filter on the same oracle and adapter', () => {
    expect(OWN[10143]!.oracle.toLowerCase()).toBe(D.contracts.ResolutionOracle.address.toLowerCase())
    expect(OWN[10143]!.adapter.toLowerCase()).toBe(D.contracts.UmaAdapter.address.toLowerCase())
  })

  it('recorded and synthetic fixtures route through the current deployment without relaxing source filters', () => {
    const items = simulateItems()
    expect(items).toHaveLength(57)
    for (const item of items) {
      const configured = source(item.contract)
      expect(lower(configured.address)).toContain(item.srcAddress)
      expect(item.block.number).toBeGreaterThanOrEqual(chain.start_block)
      expect(item.block.number).toBeGreaterThanOrEqual(configured.start_block ?? chain.start_block)
      expect(item.block.number).toBeLessThan(AFTER_REPLAY_BLOCK)
    }
    expect(TESTNET.ResolutionOracle).toBe(OWN[10143]!.oracle.toLowerCase())
    expect(TESTNET.UmaAdapter).toBe(OWN[10143]!.adapter.toLowerCase())
    expect(lower(source('TradingEngine').address)).toContain(TESTNET.TradingEngine)
    expect(AFTER_REPLAY_BLOCK).toBeGreaterThanOrEqual(Math.max(chain.start_block, ...chain.contracts.map((c: { start_block?: number }) => c.start_block ?? chain.start_block)))
    expect(() => fixtureAddress('UnconfiguredFixtureContract')).toThrow('requires a configured address')
  })

  it('the ABIs are the committed forge-inspect exports', () => {
    for (const c of config.contracts.filter((x: { abi_file_path?: string }) => x.abi_file_path)) {
      if (c.name.startsWith('Trading')) {
        const artifact = c.name === 'TradingEngine' ? 'book-risk-engine-abi' : 'vault-abi'
        const original = JSON.parse(readFileSync(`${ROOT}../artifacts/risk/${artifact}.json`, 'utf8')).abi
        const actual = JSON.parse(readFileSync(new URL(`../${c.abi_file_path}`, import.meta.url), 'utf8'))
        for (const event of actual) expect(event).toEqual(original.find((v: { type: string; name: string }) => v.type === 'event' && v.name === event.name))
      } else expect(c.abi_file_path).toBe(`../abi/${c.name}.json`)
    }
  })
})

// Shared handler registrations must be present in either network configuration.
it('mainnet and testnet expose the same contracts and event definitions', () => {
  const mainnet = parse(readFileSync(new URL('../config.mainnet.yaml', import.meta.url), 'utf8'))
  expect(mainnet.contracts).toEqual(config.contracts)
})
