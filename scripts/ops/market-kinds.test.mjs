import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeExitPolicy, NATIVE_ROLES } from './market-kinds.mjs';
import { topUpConfig } from './auto-topup.mjs';
import { exitPolicy } from './market-supervisor.mjs';

test('a native worker that finishes stays stopped; configuration and gas failures block', () => {
  assert.deepEqual(nativeExitPolicy({ code: 0 }), { action: 'done', reason: 'finished' });
  for (const text of ['Error: LISTING_PIN_MISMATCH_rulesHash', 'Error: MISSING_MAKER_KEY', 'SOURCE_NOT_CONFIGURED_FOR_SIGNER', 'BAD_MARKET_IDS'])
    assert.equal(nativeExitPolicy({ code: 1, text }).reason, 'operator-review-required', text);
  for (const text of ['Details: insufficient funds for gas * price + value', '12:00:00Z keeper balance 1.2 MON < 2: stopping'])
    assert.equal(nativeExitPolicy({ code: 3, text }).reason, 'operator-gas-low', text);
});

test('any other native exit restarts with backoff capped at five minutes and never gives up', () => {
  const delays = [0, 1, 2, 5, 6, 20, 500].map(restarts => nativeExitPolicy({ code: 1, text: 'RpcRequestError: RPC Request failed.', restarts }));
  assert.ok(delays.every(d => d.action === 'restart'));
  assert.deepEqual(delays.map(d => d.delayMs), [5_000, 10_000, 20_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(nativeExitPolicy({ code: null, signal: 'SIGKILL' }).action, 'restart');
});

test('a mined revert of a keeper operation restarts within the restart budget', () => {
  const text = 'error: Transaction reverted: 0x604e75211e5b8c19cb74d6ffdc7da8ff7b0256b62d293b845d5178b562f96c1b; no next operation sent';
  assert.deepEqual(exitPolicy({ code: 1, text, restarts: 0 }), { action: 'restart', delayMs: 5_000, reason: 'mined-revert' });
  assert.deepEqual(exitPolicy({ code: 1, text, restarts: 5 }), { action: 'block', reason: 'restart-limit' });
  assert.equal(exitPolicy({ code: 1, text: 'error: Transaction reverted: 0x12; no next operation sent' }).reason, 'unexpected-worker-exit');
});

test('auto top-up refills native operator roles and still rejects unknown roles', () => {
  const config = topUpConfig({ rootEnvFile: 'tmp/root.env', amountsMon: Object.fromEntries(NATIVE_ROLES.map(r => [r, 5])) });
  assert.deepEqual(Object.keys(config.amountsWei).sort(), [...NATIVE_ROLES].sort());
  assert.throws(() => topUpConfig({ rootEnvFile: 'tmp/root.env', amountsMon: { USER_WALLET: 5 } }), /INVALID_TOPUP_AMOUNTS/);
});

test('a publisher stopped by an expired relay reservation restarts after 5 s, without a restart limit', () => {
  const text = '{"at":"2026-10-13T21:38:19.971Z","stoppedFor":"RELAY_HEADROOM_EXPIRED"}';
  for (const restarts of [0, 1, 5, 50]) assert.deepEqual(exitPolicy({ code: 1, text, restarts }), { action: 'restart', delayMs: 5_000, reason: 'relay-headroom-expired' });
  // Only that exact stop: a quarantined reservation or nonce failure still needs an operator.
  assert.equal(exitPolicy({ code: 1, text: '{"stoppedFor":"RESERVED_NONCE_HEADROOM_EXPIRED"}' }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: 'Error: RELAY_HEADROOM_EXPIRED_NONCE_TOO_LOW' }).action, 'block');
});
