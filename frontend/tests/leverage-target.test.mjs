import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leverageLots, targetLeverageLots } from '../src/lib/leverage.ts';

const Q = 10n ** 24n; // per USDC
const mark = 795n * 10n ** 15n; // 0.795
const leverageAfter = ({ equityQ, positionLots, lots, isBuy, tick }) => {
  // Independent check of the Position panel definition after the fill.
  const markQ = mark * 1000n, entryQ = BigInt(tick) * 10n ** 18n;
  const loss = (isBuy ? entryQ - markQ : markQ - entryQ);
  const n1 = positionLots + (isBuy ? lots : -lots);
  const w = n1 >= 0n ? markQ : 10n ** 21n - markQ;
  const e1 = equityQ - lots * (loss > 0n ? loss : 0n);
  return Number((n1 < 0n ? -n1 : n1) * w * 1_000_000n / e1) / 1_000_000;
};

test('flat accounts keep the existing sizing exactly', () => {
  for (const [isBuy, tick] of [[true, 805], [false, 785]]) for (const x of [1, 3, 5])
    assert.equal(targetLeverageLots({ equityQ: 600n * Q, positionLots: 0n, tick, isBuy, leverage: x, markWad: mark }),
      leverageLots(600n * Q, tick, isBuy, x, mark));
});

test('adding to a long: 500 claims, 600 USDC equity (0.6625x) to 2x at 0.805', () => {
  // x = (2*600e24 - 500000*795e18) / (795e18 + 2*10e18) = 802.5e24 / 815e18 = 984,662.57 -> 984,662
  const lots = targetLeverageLots({ equityQ: 600n * Q, positionLots: 500_000n, tick: 805, isBuy: true, leverage: 2, markWad: mark });
  assert.equal(lots, 984_662n);
  const after = leverageAfter({ equityQ: 600n * Q, positionLots: 500_000n, lots, isBuy: true, tick: 805 });
  assert.ok(after <= 2 && after > 1.9999, String(after));
});

test('reducing a long: 500 claims, 150 USDC equity (2.65x) to 2x at 0.785, rounded up, never above target', () => {
  // x = (397.5e24 - 300e24) / (795e18 - 2*10e18) = 97.5e24 / 775e18 = 125,806.45 -> 125,807
  const lots = targetLeverageLots({ equityQ: 150n * Q, positionLots: 500_000n, tick: 785, isBuy: false, leverage: 2, markWad: mark });
  assert.equal(lots, 125_807n);
  assert.ok(leverageAfter({ equityQ: 150n * Q, positionLots: 500_000n, lots, isBuy: false, tick: 785 }) <= 2);
  assert.ok(leverageAfter({ equityQ: 150n * Q, positionLots: 500_000n, lots: lots - 1n, isBuy: false, tick: 785 }) > 2, 'one lot fewer would exceed 2x');
});

test('adding to a short uses the NO price: -500 claims, 600 USDC to 1x at 0.785', () => {
  // w = 205e18; x = (600e24 - 500000*205e18) / (205e18 + 10e18) = 497.5e24 / 215e18 = 2,313,953.49 -> 2,313,953
  assert.equal(targetLeverageLots({ equityQ: 600n * Q, positionLots: -500_000n, tick: 785, isBuy: false, leverage: 1, markWad: mark }), 2_313_953n);
});

test('targets not reachable in the chosen direction return zero; nothing ever flips the position', () => {
  const base = { equityQ: 150n * Q, positionLots: 500_000n, markWad: mark };
  assert.equal(targetLeverageLots({ ...base, tick: 805, isBuy: true, leverage: 1 }), 0n, 'already above 1x: adding cannot reach it');
  assert.equal(targetLeverageLots({ ...base, tick: 785, isBuy: false, leverage: 3 }), 0n, 'already below 3x: reducing cannot reach it');
  const lots = targetLeverageLots({ ...base, tick: 785, isBuy: false, leverage: 1 });
  assert.ok(lots > 0n && lots < 500_000n, 'reduces toward 1x without closing or flipping');
});

test('an open position needs a live mark and valid inputs', () => {
  assert.throws(() => targetLeverageLots({ equityQ: Q, positionLots: 1n, tick: 500, isBuy: true, leverage: 2 }), /live mark/);
  assert.throws(() => targetLeverageLots({ equityQ: 0n, positionLots: 1n, tick: 500, isBuy: true, leverage: 2, markWad: mark }), /Invalid/);
  assert.throws(() => targetLeverageLots({ equityQ: Q, positionLots: 1n, tick: 500, isBuy: true, leverage: 6, markWad: mark }), /Invalid/);
});
