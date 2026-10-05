import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookTicks, depthBarWidth } from '../src/lib/book-depth.ts';

test('depth bars distinguish 10%, 50% and 100% liquidity', () => {
  assert.deepEqual([10n, 50n, 100n].map(lots => depthBarWidth(lots, 100n, 180)), [18, 90, 180]);
  assert.equal(depthBarWidth(1n, 10n ** 30n, 180), 2);
  assert.equal(depthBarWidth(0n, 100n, 180), 0);
});

test('a wide spread includes real bids and asks within a bounded sample', () => {
  const ticks = bookTicks(100, 900);
  assert.ok(ticks.includes(100), 'best bid missing');
  assert.ok(ticks.includes(900), 'best ask missing');
  assert.ok(ticks.includes(99) && ticks.includes(901), 'adjacent resting levels missing');
  assert.ok(ticks.length <= 62);
});

test('empty, one-sided and endpoint books stay inside supported ticks', () => {
  assert.deepEqual(bookTicks(0, 0), []);
  assert.ok(bookTicks(500, 0).includes(500));
  assert.ok(bookTicks(0, 500).includes(500));
  const edges = bookTicks(1, 999);
  assert.ok(edges.includes(1) && edges.includes(999));
  assert.ok(edges.every(tick => tick >= 1 && tick <= 999));
});
