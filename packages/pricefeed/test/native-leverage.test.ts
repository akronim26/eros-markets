import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeLeverageOk } from '../src/native/leverage.js';

// Hand-written cases from the listing rule (ListNativeSpotPerp.s.sol LEVERAGE_NEEDS_LIQUIDATION) and the
// activation rule (a ceiling above 1x needs a staged profile). Profile hash below is the one the 5x
// Warriors perp activated with on Monad testnet; any non-zero 32-byte hash is equivalent here.
const PROFILE = '0x1a4bd2261318f3ccfe131d252b39cc284ff6625d8b06cf207968a345a1fc302f';
const ZERO = '0x' + '0'.repeat(64);

test('nativeLeverageOk: 1x needs funding off only', () => {
  assert.equal(nativeLeverageOk({ deploymentCapX: 1n, maxLiqLotsPerBlock: 0n, fundingEnabled: false }, ZERO), true);
  assert.equal(nativeLeverageOk({ deploymentCapX: 1n, maxLiqLotsPerBlock: 100000n, fundingEnabled: false }, PROFILE), true);
  assert.equal(nativeLeverageOk({ deploymentCapX: 1n, maxLiqLotsPerBlock: 0n, fundingEnabled: true }, ZERO), false);
});

test('nativeLeverageOk: above 1x needs liquidation and a staged profile', () => {
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 100000n, fundingEnabled: false }, PROFILE), true);
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 0n, fundingEnabled: false }, PROFILE), false);
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 100000n, fundingEnabled: false }, ZERO), false);
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 100000n, fundingEnabled: true }, PROFILE), false);
  assert.equal(nativeLeverageOk({ deploymentCapX: 2n, maxLiqLotsPerBlock: 1n, fundingEnabled: false }, PROFILE), true);
});

test('nativeLeverageOk: malformed inputs fail closed', () => {
  assert.equal(nativeLeverageOk({ deploymentCapX: 0n, maxLiqLotsPerBlock: 0n, fundingEnabled: false }, ZERO), false);
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 100000n, fundingEnabled: false }, '0x1234'), false);
  assert.equal(nativeLeverageOk({ deploymentCapX: 5n, maxLiqLotsPerBlock: 100000n, fundingEnabled: false }, ''), false);
});
