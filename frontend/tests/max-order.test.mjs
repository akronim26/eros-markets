import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMaxOrder } from '../src/lib/max-order.ts';

function contract(capacity, seen) {
  return async (lots, block) => {
    seen.push({ lots, block });
    let cap = lots;
    while (cap > capacity) cap /= 2n;
    return { rejection: cap > 0n ? 0 : 1, acceptedCapLots: cap, feeCapQ: cap * 2n };
  };
}

test('Max searches above a tiny current request and above the conservative halving cap', async () => {
  const seen = [];
  const result = await findMaxOrder({ block: 99n, minLots: 1n, maxLots: 1n << 40n, preview: contract(12_501n, seen), maxCalls: 32 });
  assert.equal(seen[0].lots, 1n << 40n);
  assert.equal(seen[1].lots, 8192n, 'verifies the high request\'s halving hint');
  assert.equal(result.lots, 12_501n); assert.equal(result.searchComplete, true);
  assert.ok(seen.every(p => p.block === 99n));
  assert.equal(result.preview.acceptedCapLots, result.lots);
});

test('bounded search returns useful verified capacity without claiming an exact maximum', async () => {
  const seen = [];
  const result = await findMaxOrder({ block: 100n, minLots: 1n, maxLots: 1n << 40n, preview: contract(12_501n, seen), maxCalls: 4 });
  assert.equal(result.calls, 4); assert.equal(result.searchComplete, false);
  assert.ok(result.lots >= 8192n && result.lots <= 12_501n);
  assert.ok(result.upperBoundLots > result.lots);
  assert.equal(result.label, 'Largest verified size');
});

test('no capacity, listing maximum, below-minimum range, and RPC failure remain distinct', async () => {
  assert.equal((await findMaxOrder({ block: 1n, minLots: 10n, maxLots: 100n, preview: contract(0n, []) })).lots, 0n);
  const all = await findMaxOrder({ block: 1n, minLots: 1n, maxLots: 100n, preview: contract(200n, []) });
  assert.equal(all.lots, 100n); assert.equal(all.calls, 1); assert.equal(all.searchComplete, true);
  assert.equal((await findMaxOrder({ block: 1n, minLots: 10n, maxLots: 0n, preview: async () => { throw new Error('must not call'); } })).calls, 0);
  await assert.rejects(findMaxOrder({ block: 1n, minLots: 1n, maxLots: 100n, preview: async () => { throw new Error('RPC unavailable'); } }), /RPC unavailable/);
});

test('aborted and malformed previews cannot become usable Max results', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(findMaxOrder({ block: 1n, minLots: 1n, maxLots: 100n, preview: contract(100n, []), signal: controller.signal }));
  await assert.rejects(findMaxOrder({ block: 1n, minLots: 1n, maxLots: 100n, preview: async lots => ({ rejection: 0, acceptedCapLots: lots + 1n, feeCapQ: 0n }) }), /Invalid contract/);
});
