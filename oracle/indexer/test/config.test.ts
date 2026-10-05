// config.yaml and the handlers' address table must match deployments/monad-testnet.json.
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { OWN } from '../src/addresses'

const ROOT = new URL('../../', import.meta.url).pathname
const D = JSON.parse(readFileSync(`${ROOT}deployments/monad-testnet.json`, 'utf8'))
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

  it('OOv3, the sandbox DVM and both forwarders from the deployment record', () => {
    expect(lower(source('OptimisticOracleV3').address)).toEqual([D.uma.oov3.toLowerCase()])
    expect(lower(source('ErosSandboxOracle').address)).toEqual([D.uma.sandboxOracle.toLowerCase()])
    expect(lower(source('KeystoneForwarder').address)).toEqual([D.cre.mockForwarder.toLowerCase(), D.cre.keystoneForwarder.toLowerCase()])
    // deployed before the oracle (DeployUmaSandbox runs first); nothing is missed from the chain start block
    for (const n of ['OptimisticOracleV3', 'ErosSandboxOracle']) expect(source(n).start_block).toBeLessThan(D.contracts.ResolutionOracle.deployBlock)
    expect(chain.start_block).toBeLessThanOrEqual(Math.min(...chain.contracts.map((c: { start_block: number }) => c.start_block)))
  })

  it('the handlers filter on the same oracle and adapter', () => {
    expect(OWN[10143]!.oracle.toLowerCase()).toBe(D.contracts.ResolutionOracle.address.toLowerCase())
    expect(OWN[10143]!.adapter.toLowerCase()).toBe(D.contracts.UmaAdapter.address.toLowerCase())
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
