import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentManifests, manifestForEngine, markets } from '../../src/config/deployment';
import { ownerTrader } from '../../src/lib/trader';
const owner = '0x1111111111111111111111111111111111111111';
test('every current and archived owner operation stays bound to that deployment vault', () => {
  for (const manifest of deploymentManifests) for (const market of manifest.markets) {
    assert.equal(manifestForEngine(market.engine), manifest);
    const sdk = ownerTrader(market.engine, owner);
    assert.equal(sdk.market.engine, market.engine);
    assert.equal(sdk.vault, manifest.contracts.CollateralVault.address);
    assert.equal(sdk.deposit(1n).address, manifest.contracts.CollateralVault.address);
    assert.equal(sdk.withdraw(1n).address, manifest.contracts.CollateralVault.address);
    assert.equal(sdk.approve(1n).args[0], manifest.contracts.CollateralVault.address);
    assert.equal(sdk.allocate(1n).args[0], market.engine);
    assert.equal(sdk.release(1n).address, market.engine);
    assert.ok(markets.some(m => m.engine === market.engine));
  }
  assert.throws(() => ownerTrader('0x2222222222222222222222222222222222222222', owner), /verified deployment/);
});
