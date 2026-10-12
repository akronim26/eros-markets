import test from 'node:test';
import assert from 'node:assert/strict';
import { BookChangeWatch, BOOK_CHANGE_MAX_RANGE } from './book-change-sampling.mjs';

const ENGINE = '0x00000000000000000000000000000000000000e1';
function harness(logsByBlock) {
  let now = 10_000;
  const calls = [];
  const client = { getLogs: async ({ fromBlock, toBlock }) => {
    calls.push([fromBlock, toBlock]);
    const out = [];
    for (let b = fromBlock; b <= toBlock; b++) for (const name of logsByBlock[b] ?? []) out.push({ address: ENGINE, blockNumber: b, name });
    return out;
  } };
  const watch = new BookChangeWatch({ client, engine: ENGINE, decode: log => log.name, now: () => now });
  return { watch, calls, advance: ms => { now += ms; } };
}

test('a fill or requote after the capture makes a sample due; sampler logs do not', async () => {
  const { watch, advance } = harness({ 101: ['ObservationAccepted', 'PerpObservationRecorded'], 103: ['BookDepthCaptured'], 105: ['Fill'] });
  watch.captured(100n);
  assert.equal(await watch.scan(104n), undefined);
  assert.equal(watch.due(), false);
  advance(1000);
  assert.equal(await watch.scan(106n), 105n);
  assert.equal(watch.due(), true);
});

test('a new capture after the change clears it; an older capture does not', async () => {
  const { watch } = harness({ 105: ['OrderPlaced'] });
  watch.captured(100n);
  await watch.scan(110n);
  watch.captured(104n);
  assert.equal(watch.due(), true, 'capture before the change is still stale');
  watch.captured(106n);
  assert.equal(watch.due(), false);
});

test('scans are throttled, chunked to the provider range limit and resume from the cursor', async () => {
  const { watch, calls, advance } = harness({});
  watch.captured(100n);
  await watch.scan(125n);
  assert.deepEqual(calls, [[101n, 100n + BOOK_CHANGE_MAX_RANGE], [111n, 120n], [121n, 125n]]);
  await watch.scan(130n);
  assert.equal(calls.length, 3, 'second scan within a second is skipped');
  advance(1000);
  await watch.scan(130n);
  assert.deepEqual(calls.at(-1), [126n, 130n]);
});

test('triggered samples are rate-limited on a busy book', async () => {
  const { watch, advance } = harness({ 101: ['OrderCancelled'] });
  watch.captured(100n);
  await watch.scan(101n);
  assert.equal(watch.due(), true);
  watch.triggered();
  assert.equal(watch.due(), false);
  advance(19_999);
  assert.equal(watch.due(), false);
  advance(1);
  assert.equal(watch.due(), true);
});

test('nothing is scanned before the first known capture', async () => {
  const { watch, calls } = harness({ 1: ['Fill'] });
  assert.equal(await watch.scan(50n), undefined);
  assert.equal(calls.length, 0);
});

test('the head is read only when a scan actually runs', async () => {
  const { watch, advance } = harness({});
  let reads = 0;
  watch.captured(100n);
  await watch.scan(async () => { reads++; return 101n; });
  await watch.scan(async () => { reads++; return 102n; });
  assert.equal(reads, 1);
  advance(1000);
  await watch.scan(async () => { reads++; return 102n; });
  assert.equal(reads, 2);
});
