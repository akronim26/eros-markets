import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceRuntime, liquidationPolicy, keeperActions, transientServiceRead } from './service-runtime-policy.mjs';

test('only an explicit persistent mode removes the deadline; malformed duration is still rejected', () => {
  assert.equal(serviceRuntime({}, '60', 100).end, 60100);
  assert.equal(serviceRuntime({ EROS_SERVICE_MODE: 'persistent' }, '60', 100).end, Infinity);
  for (const mode of ['', 'forever', 'true']) assert.throws(() => serviceRuntime({ EROS_SERVICE_MODE: mode }));
  for (const value of ['0', '-1', '59', '86401', 'Infinity', '100.5'])
    assert.throws(() => serviceRuntime({ EROS_SERVICE_MODE: 'persistent', EROS_SERVICE_DURATION_SECONDS: value }));
});

test('liquidation requires a measured gas limit and keeps explicit disabling available', () => {
  assert.equal(liquidationPolicy({}, undefined).enabled, false);
  assert.equal(liquidationPolicy({}, 500000).enabled, true);
  assert.equal(liquidationPolicy({ EROS_LIQUIDATION_ENABLED: 'false' }, 500000).enabled, false);
  assert.throws(() => liquidationPolicy({ EROS_LIQUIDATION_ENABLED: 'true' }, undefined), /MEASURED/);
  assert.throws(() => liquidationPolicy({ EROS_LIQUIDATION_INTERVAL_MS: '0' }, 500000));
});

test('a continuously due sample cannot starve liquidation; scan cooldown leaves sampling turns', () => {
  assert.deepEqual(keeperActions({ liquidationEnabled: true, nextLiquidationAt: 10000, now: 10000 }), ['rollover', 'liquidate', 'sample']);
  assert.deepEqual(keeperActions({ liquidationEnabled: true, nextLiquidationAt: 20000, now: 10001 }), ['rollover', 'sample']);
  assert.deepEqual(keeperActions({ liquidationEnabled: false, nextLiquidationAt: 0, now: 10001 }), ['rollover', 'sample']);
});

test('wrapped pool failures can retry but signing and canonical receipt failures cannot', () => {
  for (const reason of ['RPC_POOL_UNAVAILABLE', 'RPC_POOL_BUSY', 'RPC_POOL_BLOCK_CHANGED'])
    assert.equal(transientServiceRead(new Error('rpc wrapped', { cause: new Error(reason) })), true);
  for (const reason of ['MAKER_UNTRACKED_NONCE', 'MAKER_RECEIPT_NONCANONICAL', 'MAKER_PENDING_IDENTITY_MISMATCH'])
    assert.equal(transientServiceRead(new Error(reason)), false);
});
