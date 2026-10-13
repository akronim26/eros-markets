import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeL2, previewBuy, previewSell, minOut, bidLockAtoms, askLockAtoms } from '../src/lib/spot-math.ts';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
test('decodes the live YES book layout: block, bids until zero, asks', () => {
  const l2 = decodeL2(`0x${[70624318, 661, 124000, 0, 681, 131000].map(word).join('')}`);
  assert.equal(l2.block, 70624318n);
  assert.deepEqual(l2.bids, [{ tick: 661, lots: 124000n }]);
  assert.deepEqual(l2.asks, [{ tick: 681, lots: 131000n }]);
  assert.throws(() => decodeL2(`0x${[1, 1000, 5, 0].map(word).join('')}`)); // price >= 1 is out of domain
});
test('matches fork fills: 6.81 tUSDC buys exactly 10 YES at 0.681; 10 YES sells for 6.61 at 0.661', () => {
  // Fork receipts: placeAndExecuteMarketBuy(6810, ...) returned 10_000_000; MarketSell(10_000 lots) returned 6_610_000.
  const buy = previewBuy([{ tick: 681, lots: 131000n }], 6_810_000n);
  assert.equal(buy.outAtoms, 10_000_000n); assert.equal(buy.inAtoms, 6_810_000n); assert.equal(buy.complete, true);
  // Fork: a non-FOK MarketBuy(50000 units = 50 tUSDC) at ask 0.681 returned 73_421_000 atoms.
  assert.equal(previewBuy([{ tick: 681, lots: 131000n }], 50_000_000n).outAtoms, 73_421_000n);
  const sell = previewSell([{ tick: 661, lots: 124000n }], 10_000n);
  assert.equal(sell.outAtoms, 6_610_000n); assert.equal(sell.complete, true);
});
test('walks levels, reports partial fills and rounds the quote down to whole units', () => {
  const asks = [{ tick: 500, lots: 2000n }, { tick: 600, lots: 1000n }];
  const all = previewBuy(asks, 1_600_999n);               // 999 atoms below a quote unit are not spent
  assert.equal(all.lots, 3000n); assert.equal(all.inAtoms, 1_600_000n); assert.equal(all.worstTick, 600); assert.equal(all.complete, false); // book exhausted exactly
  const thin = previewSell([{ tick: 400, lots: 1000n }], 5000n);
  assert.equal(thin.complete, false); assert.equal(thin.lots, 1000n); assert.equal(thin.outAtoms, 400_000n);
  assert.equal(previewBuy([], 1_000_000n).lots, 0n);
  assert.equal(previewBuy(asks, 5_000_000n).complete, false); // more budget than the book holds
  assert.equal(previewBuy(asks, 1_000_000n).complete, true);
});
test('slippage floor, fees and lock amounts', () => {
  assert.equal(minOut(10_000_000n, 100), 9_900_000n);
  assert.equal(previewSell([{ tick: 500, lots: 1000n }], 1000n, 30n).outAtoms, 498_500n); // 0.3% taker fee, as on the fork
  assert.equal(bidLockAtoms(480, 10_000n), 4_800_000n); assert.equal(askLockAtoms(10_000n), 10_000_000n);
});
