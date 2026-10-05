import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSourceLease } from '../src/supervisor.js';

test('supervisor does not launch a replacement when an elapsed timer precedes wall-clock lease expiry', async () => {
  const stop = new AbortController(); let wall = 1000, elapsed = 0, sleeps = 0;
  await waitForSourceLease(() => BigInt(1200 - wall), stop.signal, () => {}, {
    elapsed: () => elapsed, sleep: async ms => { elapsed += ms; if (++sleeps > 1) wall += ms; },
  });
  assert.equal(sleeps, 2); assert.ok(wall >= 1200); assert.ok(elapsed > wall - 1000);
});

test('supervisor rechecks a changed lease and aborts without acquisition or restart consumption', async () => {
  const stop = new AbortController(); let reads = 0, sleeps = 0;
  await waitForSourceLease(() => { ++reads; return 10000n; }, stop.signal, () => {}, {
    sleep: async () => { if (++sleeps === 2) stop.abort(); },
  });
  assert.equal(reads, 2); assert.equal(sleeps, 2);
});

test('supervisor bounds a stalled wall clock and rejects an excessive lease instead of forcing it', async () => {
  const stop = new AbortController(); let elapsed = 0;
  await assert.rejects(waitForSourceLease(() => 1000n, stop.signal, () => {}, {
    elapsed: () => elapsed, timeoutMs: 2000, sleep: async ms => { elapsed += ms; },
  }), /SERVICE_LEASE_EXPIRY_WAIT_TIMEOUT/);
  assert.equal(elapsed, 2000);
  await assert.rejects(waitForSourceLease(() => 3600001n, stop.signal, () => {}), /SERVICE_LEASE_WAIT_TOO_LONG/);
});
