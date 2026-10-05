import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { assertKeeperChain, loadKeeperConfiguration } from '../src/config'

const temporary = mkdtempSync(join(tmpdir(), 'keeper config '))
const runtimeCodehash = `0x${'12'.repeat(32)}` as const
const fixture = JSON.parse(readFileSync(new URL('../../../packages/oracle-sdk/test/fixtures/deployments.monad-testnet.json', import.meta.url), 'utf8'))
const registry = fixture.contracts.MarketRegistry.address
let serial = 0

function writeJson(name: string, value: unknown): string {
  const path = join(temporary, `${serial++}-${name}.json`)
  writeFileSync(path, JSON.stringify(value))
  return path
}

function environment(deployment = fixture) {
  return {
    NETWORK: deployment.network,
    RPC_URL: 'http://127.0.0.1:8545',
    KEEPER_PRIVATE_KEY: `0x${'01'.repeat(32)}`,
    DEPLOYMENTS_FILE: writeJson('deployment', deployment),
    ENGINE_IDENTITIES_FILE: writeJson('identities', {
      version: 1,
      chainId: deployment.chainId,
      registry,
      profiles: [{ kind: 'book-risk', runtimeCodehash }],
    }),
    GAS_FILE: writeJson('gas', { calls: { haltScheduled: { limit: 600000 } } }),
  }
}

function localDeployment() {
  const { UmaAdapter: venue, ...contracts } = fixture.contracts
  return {
    scope: 'local-only',
    network: 'local-integration',
    chainId: 31337,
    usdc: fixture.usdc,
    contracts: { ...contracts, MockAssertionVenue: venue },
    assertionVenue: { kind: 'mock', address: venue.address },
  }
}

afterAll(() => {
  const target = relative(tmpdir(), temporary)
  if (target && !target.startsWith('..') && !isAbsolute(target)) rmSync(temporary, { recursive: true, force: true })
})

describe('explicit keeper configuration', () => {
  test('loads an ordinary deployment and separate gas file from paths containing spaces', () => {
    const loaded = loadKeeperConfiguration(environment())
    expect(loaded.deployments.chainId).toBe(10143)
    expect(loaded.gas.calls.haltScheduled.limit).toBe(600000)
    expect(loaded.engineIdentities.profiles[0].runtimeCodehash).toBe(runtimeCodehash)
  })

  test('a local manifest identifies the mock venue without a fake UmaAdapter', () => {
    const loaded = loadKeeperConfiguration(environment(localDeployment()))
    expect(loaded.deployments.chainId).toBe(31337)
    expect(loaded.deployments.contracts.UmaAdapter).toBeUndefined()
    expect(loaded.deployments.contracts.MockAssertionVenue).toBeDefined()
  })

  test('local-only safety constraints cannot be bypassed by a manifest or endpoint change', () => {
    for (const changes of [
      { chainId: 10143 },
      { scope: 'testnet' },
      { network: 'monad-testnet' },
      { assertionVenue: { kind: 'mock', address: registry } },
      { assertionVenue: { kind: 'uma', address: fixture.contracts.UmaAdapter.address } },
    ]) {
      const env = environment({ ...localDeployment(), ...changes })
      env.NETWORK = 'local-integration'
      expect(() => loadKeeperConfiguration(env)).toThrow()
    }
    const env = environment(localDeployment())
    for (const endpoint of [
      'https://example.com', 'http://127.0.0.1.example.com', 'http://192.168.0.1:8545',
      'ftp://localhost', 'http://user:password@localhost:8545', 'http://localhost:8545/?token=example',
    ]) {
      expect(() => loadKeeperConfiguration({ ...env, RPC_URL: endpoint })).toThrow(/loopback/)
    }
    expect(() => loadKeeperConfiguration({ ...env, GAS_FILE: undefined })).toThrow(/explicit/)
    expect(() => loadKeeperConfiguration({ ...env, DEPLOYMENTS_FILE: undefined })).toThrow(/explicit/)
  })

  test('ordinary manifests still require the production schema and matching network', () => {
    const { UmaAdapter, ...contracts } = fixture.contracts
    expect(() => loadKeeperConfiguration(environment({ ...fixture, contracts }))).toThrow(/UmaAdapter/)
    const env = environment()
    expect(() => loadKeeperConfiguration({ ...env, NETWORK: 'monad-mainnet' })).toThrow(/expected monad-mainnet/)
  })

  test('identity chain and registry mismatches are still refused', () => {
    const env = environment(localDeployment())
    for (const changes of [{ chainId: 10143 }, { registry: fixture.usdc }]) {
      const path = writeJson('bad-identities', {
        version: 1, chainId: 31337, registry, profiles: [{ kind: 'book-risk', runtimeCodehash }], ...changes,
      })
      expect(() => loadKeeperConfiguration({ ...env, ENGINE_IDENTITIES_FILE: path })).toThrow()
    }
  })

  test('startup rejects the wrong actual chain before jobs can run', async () => {
    await expect(assertKeeperChain({ getChainId: async () => 31337 }, 31337)).resolves.toBeUndefined()
    await expect(assertKeeperChain({ getChainId: async () => 10143 }, 31337)).rejects.toThrow('keeper RPC chainId 10143, expected 31337')
  })
})
