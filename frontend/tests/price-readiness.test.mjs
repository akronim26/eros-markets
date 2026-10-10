import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestSourceObservation, priceReadiness } from '../src/lib/price-chart.ts';
import { marketChip } from '../src/lib/enums.ts';
const point = (t, v = 0.285, valid = true) => ({ block: 1n, t, v, valid });

test('cached chart prices never become executable index or live source prices', () => {
  const source = latestSourceObservation([point(100)], 300);
  assert.equal(source.point.v, 0.285);
  assert.equal(source.fresh, false);
  assert.match(priceReadiness({ indexAvailable: false, markAvailable: false, pricingMode: 0 }, source.fresh), /historical/);
  assert.equal(marketChip({ active: true, halted: false, stage: 0, accountingState: 0, pricingMode: 0, indexAvailable: false, markAvailable: false }).label, 'Index window unavailable');
});
test('fresh source prices still require independent execution windows and normal-pricing activation', () => {
  assert.equal(latestSourceObservation([point(100)], 120).fresh, true);
  assert.match(priceReadiness({ indexAvailable: false, markAvailable: false, pricingMode: 0 }, true), /still warming up/);
  assert.match(priceReadiness({ indexAvailable: true, markAvailable: false, pricingMode: 0 }, true), /normal-pricing activation/);
  assert.match(priceReadiness({ indexAvailable: true, markAvailable: false, pricingMode: 1 }, true), /book or basis/);
  assert.equal(priceReadiness({ indexAvailable: true, markAvailable: true, pricingMode: 1 }, true), undefined);
});
test('invalid latest observation, future timestamp and read failures cannot advertise a live source', () => {
  assert.equal(latestSourceObservation([point(100), point(101, 0, false)], 102).fresh, false);
  assert.equal(latestSourceObservation([point(105)], 100).fresh, false);
  assert.equal(latestSourceObservation([point(100)], 100, true).fresh, false);
  assert.equal(latestSourceObservation([point(100, NaN)], 100).point, undefined);
});
