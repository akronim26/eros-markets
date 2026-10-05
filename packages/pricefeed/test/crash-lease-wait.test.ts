import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForExpiredLease } from '../scripts/crash-lease-wait.js';

test('crash harness rechecks wall clock when an elapsed timer fires early', async () => {
  let wall = 1000, elapsed = 0, sleeps = 0;
  const result = await waitForExpiredLease(() => 1200, { now: () => wall, elapsed: () => elapsed,
    sleep: async ms => { elapsed += ms; wall += ++sleeps === 1 ? 0 : ms; } });
  assert.ok(sleeps > 2); assert.ok(result.observedNow >= 1250);
  assert.ok(result.waitedMs > result.observedNow - 1000);
});

test('crash harness rereads changed deadlines before allowing acquisition', async () => {
  let wall = 1000, elapsed = 0, reads = 0;
  const result = await waitForExpiredLease(() => ++reads === 1 ? 1100 : 1400,
    { now: () => wall, elapsed: () => elapsed, sleep: async ms => { elapsed += ms; wall += ms; } });
  assert.equal(result.deadline, 1400); assert.ok(result.observedNow >= 1450);
});

test('crash harness bounds a stopped or backwards wall clock without takeover', async () => {
  let elapsed = 0;
  await assert.rejects(waitForExpiredLease(() => 2000, { now: () => 1000, elapsed: () => elapsed,
    sleep: async ms => { elapsed += ms; }, timeoutMs: 500 }), /CRASH_LEASE_EXPIRY_WAIT_TIMEOUT/);
  assert.equal(elapsed, 500);
});

test('already expired crash lease needs no timer', async () => {
  const result = await waitForExpiredLease(() => 1000, { now: () => 2000, elapsed: () => 0,
    sleep: async () => { throw new Error('unexpected timer'); } });
  assert.equal(result.waitedMs, 0); assert.equal(result.deadline, 1000);
});
