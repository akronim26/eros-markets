import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_TESTNET_MANIFEST, loadServiceDeployment } from '../src/deployments'

const current = JSON.parse(readFileSync(CURRENT_TESTNET_MANIFEST, 'utf8'))
test('service defaults share the frontend contracts, collateral and initial scan blocks', () => {
  const service = loadServiceDeployment('monad-testnet')
  expect(service.contracts).toEqual(current.contracts)
  expect(service.usdc).toBe(current.contracts.CollateralToken.address)
  expect(service.markets?.map(m => m.marketId)).toEqual(current.markets.map((m: { marketId: string }) => m.marketId))
})

test('an explicit manifest must retain verified testnet identity and every service pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'service-deployment-'))
  const path = join(dir, 'manifest.json')
  for (const patch of [{ verifiedAt: undefined }, { chainId: 143 }, { contracts: { ...current.contracts, KeeperRouter: undefined } },
    { contracts: { ...current.contracts, ResolutionOracle: { ...current.contracts.ResolutionOracle, deployBlock: Number(current.verifiedAt.blockNumber) + 1 } } }]) {
    writeFileSync(path, JSON.stringify({ ...current, ...patch }))
    expect(() => loadServiceDeployment('monad-testnet', { manifestFile: path })).toThrow()
  }
  expect(() => loadServiceDeployment('monad-testnet', { manifestFile: path, deploymentsFile: path })).toThrow('Choose')
})
