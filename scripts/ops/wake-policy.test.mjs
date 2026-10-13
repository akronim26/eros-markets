import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wakeConfig, wakeDecision, needsLeverageRead, lastSeenFor, readActivity, anyLeveraged, IDLE_MS } from './wake-policy.mjs';

const idleMs = IDLE_MS, now = 10_000_000;

test('awake market sleeps only after the idle timeout with no leveraged account', () => {
  const awake = { state: 'awake', nowMs: now, idleMs };
  assert.deepEqual(wakeDecision({ ...awake, lastSeenMs: now - 1000, leveraged: false }), { action: 'stay' });
  assert.deepEqual(wakeDecision({ ...awake, lastSeenMs: now - idleMs + 1, leveraged: false }), { action: 'stay' });
  assert.deepEqual(wakeDecision({ ...awake, lastSeenMs: now - idleMs, leveraged: false }), { action: 'sleep', reason: 'idle' });
  assert.deepEqual(wakeDecision({ ...awake, lastSeenMs: null, leveraged: false }), { action: 'sleep', reason: 'no-visitor' });
});

test('leveraged accounts and failed reads keep the market awake', () => {
  const idle = { state: 'awake', nowMs: now, idleMs, lastSeenMs: null };
  assert.deepEqual(wakeDecision({ ...idle, leveraged: true }), { action: 'stay', reason: 'leveraged-account' });
  assert.deepEqual(wakeDecision({ ...idle, leveraged: undefined }), { action: 'stay', reason: 'leverage-read-failed' });
  assert.deepEqual(wakeDecision({ state: 'awake', nowMs: now, idleMs, lastSeenMs: undefined, leveraged: false }), { action: 'stay' });
});

test('asleep market wakes on a visitor or an unreadable activity route', () => {
  const asleep = { state: 'asleep', nowMs: now, idleMs };
  assert.deepEqual(wakeDecision({ ...asleep, lastSeenMs: now - 5000 }), { action: 'wake', reason: 'visitor' });
  assert.deepEqual(wakeDecision({ ...asleep, lastSeenMs: undefined }), { action: 'wake', reason: 'activity-read-failed' });
  assert.deepEqual(wakeDecision({ ...asleep, lastSeenMs: null }), { action: 'stay' });
  assert.deepEqual(wakeDecision({ ...asleep, lastSeenMs: now - idleMs }), { action: 'stay' });
  assert.deepEqual(wakeDecision({ state: 'sleeping', nowMs: now, idleMs, lastSeenMs: now }), { action: 'stay' });
  assert.throws(() => wakeDecision({ state: 'odd', nowMs: now, idleMs, lastSeenMs: null }), /UNKNOWN_WAKE_STATE/);
});

test('the leverage scan runs only when the market would otherwise sleep', () => {
  assert.equal(needsLeverageRead({ state: 'awake', nowMs: now, idleMs, lastSeenMs: null }), true);
  assert.equal(needsLeverageRead({ state: 'awake', nowMs: now, idleMs, lastSeenMs: now - 1 }), false);
  assert.equal(needsLeverageRead({ state: 'awake', nowMs: now, idleMs, lastSeenMs: undefined }), false);
  assert.equal(needsLeverageRead({ state: 'asleep', nowMs: now, idleMs, lastSeenMs: null }), false);
});

test('activity responses are validated; a future heartbeat never extends awake time', () => {
  const engine = '0xAbCd';
  assert.equal(lastSeenFor({ engines: {} }, engine, now), null);
  assert.equal(lastSeenFor({ engines: { '0xabcd': now - 5 } }, engine, now), now - 5);
  assert.equal(lastSeenFor({ engines: { '0xabcd': now + 60_000 } }, engine, now), now);
  assert.throws(() => lastSeenFor({ engines: { '0xabcd': '1' } }, engine, now), /INVALID_ACTIVITY_RESPONSE/);
});

test('activity read fails closed to an error on HTTP failure', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ engines: { '0xaa': now - 1 } }) });
  assert.deepEqual(await readActivity({ fetchImpl: ok, url: 'https://x/api', engines: ['0xAA', '0xbb'], nowMs: now }), { '0xaa': now - 1, '0xbb': null });
  await assert.rejects(readActivity({ fetchImpl: async () => ({ ok: false }), url: 'https://x/api', engines: ['0xaa'], nowMs: now }), /ACTIVITY_READ_FAILED/);
});

test('wake config requires https and bounded timers', () => {
  assert.equal(wakeConfig(undefined), null);
  assert.deepEqual(wakeConfig({ url: 'https://eros.example/api/market-activity' }),
    { url: 'https://eros.example/api/market-activity', pollMs: 15_000, idleMs: 600_000 });
  assert.throws(() => wakeConfig({ url: 'http://eros.example/api' }), /HTTPS_REQUIRED/);
  assert.throws(() => wakeConfig({ url: 'https://u:p@eros.example/api' }), /CREDENTIALS_FORBIDDEN/);
  assert.throws(() => wakeConfig({ url: 'https://eros.example/api', pollMs: 1000 }), /INVALID_WAKE_POLLMS/);
});

test('any negative E0 or E1 is leveraged; fully backed makers are not', async () => {
  const accounts = [{ e0Q: 5n, e1Q: 1n }, { e0Q: 0n, e1Q: 0n }];
  const client = { readContract: async ({ functionName, args }) => functionName === 'participantCount' ? BigInt(accounts.length)
    : functionName === 'traderIdAt' ? [Number(args[0]) + 1, '0x0'] : accounts[args[0] - 1] };
  assert.equal(await anyLeveraged({ client, engine: '0xe', abi: [] }), false);
  accounts.push({ e0Q: 10n, e1Q: -1n });
  assert.equal(await anyLeveraged({ client, engine: '0xe', abi: [] }), true);
  await assert.rejects(anyLeveraged({ client, engine: '0xe', abi: [], maxParticipants: 2 }), /LEVERAGE_SCAN_LIMIT/);
});
