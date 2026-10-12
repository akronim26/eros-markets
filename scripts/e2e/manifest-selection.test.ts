import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest'
import { sameSharedContracts, selectCurrentManifest } from './manifest-selection'
import { oracleServiceDeployment } from './service-deployment'

const source = JSON.parse(readFileSync(new URL('../../frontend/src/config/public-manifest.json', import.meta.url), 'utf8'))
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
function fixture(version: number, markets = [1]) {
  const value = structuredClone(source), addresses = new Map<string, string>()
  for (const c of Object.values(value.contracts) as any[]) {
    const previous = c.address.toLowerCase()
    if (!addresses.has(previous)) addresses.set(previous, address(version * 100 + addresses.size + 1))
    c.address = addresses.get(previous)
  }
  value.markets = markets.map(i => ({ ...source.markets[0], name: `fixture-${version}-${i}`, engine: address(version * 1000 + i), marketId: hash(version * 1000 + i) }))
  return toPublicManifest(value)
}

test('selection serves exactly the incoming markets on their new shared contracts', () => {
  const first = fixture(3, [1]), second = fixture(3, [2])
  const before = JSON.stringify([first, second])
  const selected = selectCurrentManifest([first, second])
  assert.equal(selected.contracts.MarketFactory.address, first.contracts.MarketFactory.address)
  assert.equal(selected.contracts.CollateralVault.address, first.contracts.CollateralVault.address)
  assert.deepEqual(selected.markets.map(m => m.engine), [...first.markets, ...second.markets].map(m => m.engine))
  assert.equal(JSON.stringify([first, second]), before, 'selection must not mutate input manifests')
});

test('selection rejects mixed bases, unknown provenance and duplicate engines', () => {
  const fresh = fixture(2)
  assert.throws(() => selectCurrentManifest([]), /VERIFIED_DEPLOYMENTS_REQUIRED/)
  assert.throws(() => selectCurrentManifest([fresh, fixture(3)]), /INCOMING_SHARED_DEPLOYMENT_MISMATCH/)
  assert.throws(() => selectCurrentManifest([{ ...fresh, verifiedAt: undefined }]), /VERIFIED_SAME_CHAIN/)
  assert.throws(() => selectCurrentManifest([fresh, fresh]), /DUPLICATE_MARKET_IDENTITY/)
  for (const field of ['address', 'codehash', 'deployBlock']) {
    const changed = structuredClone(fresh)
    ;(changed.contracts.MarketFactory as any)[field] = field === 'address' ? address(9999) : field === 'codehash' ? hash(9999) : 1
    assert.equal(sameSharedContracts(fresh, changed), false)
  }
});

test('oracle service export derives every identity from the new verified base', () => {
  const fresh = fixture(3), previous = fixture(1)
  const roles = { SIM_RELAYER: address(4001), RUNNER_ATTESTOR: address(4002), WATCHDOG: address(4003), COMMITTEE_1: address(4006), COMMITTEE_2: address(4004), COMMITTEE_3: address(4005) }
  const base = { chainId: 10143, deployer: address(4000), roles, infrastructure: { forwarder: address(4007) } }
  const config = oracleServiceDeployment(fresh, base, 2)
  for (const [name, contract] of Object.entries(fresh.contracts)) {
    assert.equal(config.contracts[name].address, contract.address)
    assert.notEqual(config.contracts[name].address, previous.contracts[name].address)
    assert.equal(config.contracts[name].codehash, contract.codehash)
  }
  assert.equal(config.usdc, fresh.contracts.CollateralToken.address)
  assert.equal(config.roles.timelock, fresh.contracts.Timelock.address)
  assert.equal(config.uma.oov3, fresh.contracts.OptimisticOracleV3.address)
  assert.equal(config.trustSets[0].venue, fresh.contracts.UmaAdapter.address)
  assert.deepEqual(config.trustSets[0].committee.map(a => a.toLowerCase()), [roles.COMMITTEE_2, roles.COMMITTEE_3, roles.COMMITTEE_1])
  assert.equal(config.cre.keystoneForwarder.toLowerCase(), base.infrastructure.forwarder.toLowerCase())
  assert.equal(config.trustSets[0].production, false)
  assert.equal(config.globalsVersion, 2)
  assert.throws(() => oracleServiceDeployment(fresh, { ...base, chainId: 31337 }, 2), /VERIFIED_TESTNET_DEPLOYMENT_REQUIRED/)
  const missing = structuredClone(fresh); delete missing.contracts.OptimisticOracleV3
  assert.throws(() => oracleServiceDeployment(missing, base, 2), /MISSING_SERVICE_CONTRACT:OptimisticOracleV3/)
});
