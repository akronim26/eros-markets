import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalTrade, displayTickForOutcome, positionEffect, orderSizeBounds } from '../src/lib/trade-view.ts';

test('all four intents preserve complementary payoff and canonical limit direction', () => {
  for (const [outcome, direction, shown, isBuy, tick] of [
    ['YES', 'long', 613, true, 613], ['NO', 'short', 387, true, 613],
    ['YES', 'short', 613, false, 613], ['NO', 'long', 387, false, 613],
  ]) {
    const trade = canonicalTrade({ outcome, direction }, shown);
    assert.deepEqual(trade, { isBuy, side: isBuy ? 'buy' : 'sell', tick });
    assert.equal(displayTickForOutcome(outcome, tick), shown);
    for (const finalYes of [0n, 500n, 1000n]) {
      const canonicalPnl = (isBuy ? 1n : -1n) * (finalYes - BigInt(tick));
      const displayedFinal = outcome === 'YES' ? finalYes : 1000n - finalYes;
      assert.equal(canonicalPnl, (direction === 'long' ? 1n : -1n) * (displayedFinal - BigInt(shown)));
    }
  }
  for (const tick of [0, 1000, 1.5, NaN]) assert.throws(() => canonicalTrade({ outcome: 'NO', direction: 'long' }, tick));
});

test('position effect distinguishes opening, reduction, flat close, and reversal', () => {
  for (const [before, buy, size, expected, after, closing, opening] of [
    [0n, true, 100n, 'opens', 100n, 0n, 100n], [100n, true, 50n, 'increases', 150n, 0n, 50n],
    [100n, false, 40n, 'reduces', 60n, 40n, 0n], [-100n, true, 100n, 'closes', 0n, 100n, 0n],
    [100n, false, 140n, 'reverses', -40n, 100n, 40n], [-100n, true, 140n, 'reverses', 40n, 100n, 40n],
  ]) {
    const effect = positionEffect(before, buy, size);
    assert.equal(effect.kind, expected); assert.equal(effect.afterLots, after);
    assert.equal(effect.closingLots, closing); assert.equal(effect.openingLots, opening);
  }
});

test('reduce-only clips at flat and cannot manufacture exposure on an invalid side', () => {
  const close = positionEffect(100n, false, 150n, true);
  assert.equal(close.kind, 'closes'); assert.equal(close.executedLots, 100n); assert.equal(close.clippedLots, 50n);
  for (const before of [0n, 100n]) assert.equal(positionEffect(before, true, 100n, true).executedLots, 0n);
  assert.throws(() => positionEffect(1n, true, -1n));
});

test('order bounds account for current exposure, listing size, minimum and reduce-only', () => {
  const base = { positionLots: 80n, isBuy: true, reduceOnly: false, minOrderLots: 1n, maxOrderLots: 500n, maxAbsPositionLots: 100n };
  assert.deepEqual(orderSizeBounds(base), { minLots: 1n, maxLots: 20n });
  assert.equal(orderSizeBounds({ ...base, isBuy: false }).maxLots, 180n);
  assert.equal(orderSizeBounds({ ...base, isBuy: false, reduceOnly: true }).maxLots, 80n);
  assert.equal(orderSizeBounds({ ...base, minOrderLots: 21n }).maxLots, 0n);
  assert.equal(orderSizeBounds({ ...base, reservedBidLots: 15n }).maxLots, 5n);
  assert.equal(orderSizeBounds({ ...base, isBuy: false, reservedAskLots: 170n }).maxLots, 10n);
  assert.equal(orderSizeBounds({ ...base, reservedBidLots: 25n }).maxLots, 0n);
});
