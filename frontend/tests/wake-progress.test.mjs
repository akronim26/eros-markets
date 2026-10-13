import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wakeProgress } from '../src/lib/wake-progress.ts';
const base = { active: true, halted: false, accountingState: 0, indexAvailable: true, markAvailable: true, longCap: 5n, shortCap: 5n, deploymentCapX: 5n };
const done = p => p.steps.map(s => s.done);
test('a fully awake market shows no progress', () => assert.equal(wakeProgress(base), undefined));
test('steps advance price -> trading -> full leverage', () => {
  assert.deepEqual(done(wakeProgress({ ...base, indexAvailable: false, markAvailable: false, longCap: 1n, shortCap: 1n })), [false, false, false]);
  assert.deepEqual(done(wakeProgress({ ...base, markAvailable: false, longCap: 1n, shortCap: 1n })), [true, false, false]);
  assert.deepEqual(done(wakeProgress({ ...base, longCap: 1n })), [true, true, false]);
  assert.match(wakeProgress({ ...base, indexAvailable: false, accountingState: 1 }).detail, /hourly update/);
});
test('inactive, halted or archived markets never claim to be waking', () => {
  for (const m of [{ active: false }, { halted: true }, { archived: true }])
    assert.equal(wakeProgress({ ...base, indexAvailable: false, ...m }), undefined);
});
