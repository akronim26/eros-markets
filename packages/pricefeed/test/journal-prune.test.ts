import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Journal, pruneCaptures } from '../src/journal.js';

const MIN = 60_000n;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'journal-prune-'));
  const path = join(dir, 'source.sqlite'), journal = new Journal(path);
  const source = journal.acquire('source', 'owner', 0n, 10n ** 15n), life = journal.acquire('lifecycle:x', 'owner', 0n, 10n ** 15n);
  const stale = journal.acquire('stale-worker', 'owner', 0n, 10n ** 15n);
  // Source polls every 10 s for 60 min, lifecycle notes every 60 s, one worker last seen at minute 5.
  for (let s = 0n; s < 3600n; s += 10n) journal.append('source', 'owner', source, s * 1000n, { s });
  for (let s = 0n; s < 3600n; s += 60n) journal.append('lifecycle:x', 'owner', life, s * 1000n, { s, recordType: 'LIFECYCLE' });
  journal.append('stale-worker', 'owner', stale, 300_000n, { last: true });
  return { dir, path, journal };
}
const count = (path: string, worker: string) => Number(new DatabaseSync(path, { readOnly: true }).prepare('SELECT count(*) AS n FROM captures WHERE worker=?').get(worker)!.n);

test('keeps the last 30 minutes and the newest row of every worker; integrity still verifies', () => {
  const f = fixture();
  try {
    const before = { source: f.journal.latest('source'), life: f.journal.latest('lifecycle:x'), stale: f.journal.latest('stale-worker') };
    const result = pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n, batch: 37 });
    // Cutoff 1,800,000 ms: source rows at 1800..3590 s (180), lifecycle 1800..3540 s (30), stale kept as newest.
    assert.equal(count(f.path, 'source'), 180);
    assert.equal(count(f.path, 'lifecycle:x'), 30);
    assert.equal(count(f.path, 'stale-worker'), 1, 'a worker whose newest row is old still keeps it');
    assert.deepEqual(result, { deleted: 360 + 60 - 180 - 30, kept: 211 });
    assert.deepEqual({ source: f.journal.latest('source'), life: f.journal.latest('lifecycle:x'), stale: f.journal.latest('stale-worker') }, before);
    assert.equal(f.journal.verify(), true);
    assert.deepEqual(pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n }), { deleted: 0, kept: 211 }, 'idempotent');
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('the live writer keeps appending while pruning runs on its own connection', () => {
  const f = fixture();
  try {
    pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n });
    const fence = f.journal.acquire('source', 'owner', 3_600_000n, 10n ** 15n);
    f.journal.append('source', 'owner', fence, 3_600_500n, { after: true });
    assert.deepEqual(f.journal.latest('source')!.payload, { after: true });
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('refuses a retention under one minute or a malformed batch', () => {
  const f = fixture();
  try {
    assert.throws(() => pruneCaptures(f.path, { keepMs: 59_999n, nowMs: 3_600_000n }), /BAD_RETENTION_POLICY/);
    assert.throws(() => pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n, batch: 0 }), /BAD_RETENTION_POLICY/);
    assert.equal(count(f.path, 'source'), 360, 'nothing deleted on refusal');
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('long backlogs are pruned in short transactions with pauses, finishing the same result', () => {
  const f = fixture();
  try {
    const t = Date.now();
    const result = pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n, batch: 10, maxTxMs: 1, pauseMs: 5 });
    assert.deepEqual(result, { deleted: 210, kept: 211 });
    assert.ok(Date.now() - t >= 5 * 20, 'paused between at least 20 transactions');
    assert.throws(() => pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n, maxTxMs: 0 }), /BAD_RETENTION_POLICY/);
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('an exhausted time budget never stops pruning before the backlog is done', () => {
  const f = fixture();
  try {
    // maxTxMs 1 on a busy machine can elapse before the first row; each transaction still removes one.
    assert.deepEqual(pruneCaptures(f.path, { keepMs: 30n * MIN, nowMs: 3_600_000n, batch: 1, maxTxMs: 1, pauseMs: 0 }), { deleted: 210, kept: 211 });
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
