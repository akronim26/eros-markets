import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseDecimal, floorLots, priceWad } from '../src/math.js';
import { normalizeBook, summarizeBook } from '../src/book.js';

test('decimal/lot boundary preserves fractional totals and rejects malformed financial values', () => {
  assert.equal(priceWad('0.61'), 610000000000000000n);
  assert.equal(floorLots(parseDecimal('5')), 5000n);
  assert.equal(floorLots(parseDecimal('1.2349')), 1234n);
  for (const bad of ['-1', '+1', '1e-3', 'NaN', '', '0.1234567890123456789']) {
    assert.throws(() => parseDecimal(bad));
  }
  assert.throws(() => priceWad('1.001'));
});

type Vector = { name: string; bids: {price: string; size: string}[]; asks: {price: string; size: string}[];
  nLots: string; spreadWad: string; method: 'vwap' | 'marginal'; bidWad: string | null;
  askWad: string | null; midWad: string | null; valid: boolean; bidDepthLots: string; askDepthLots: string };
const vectors = JSON.parse(readFileSync(new URL('../../fixtures/impact.json', import.meta.url), 'utf8')) as Vector[];
for (const v of vectors) test(`independent Fraction fixture: ${v.name}`, () => {
  const book = normalizeBook({ bids: v.bids, asks: v.asks, tick_size: '0.000000000000000001', min_order_size: '0.001' });
  const actual = summarizeBook(book, BigInt(v.nLots), BigInt(v.spreadWad), v.method);
  assert.equal(actual.impactBidWad?.toString() ?? null, v.bidWad);
  assert.equal(actual.impactAskWad?.toString() ?? null, v.askWad);
  assert.equal(actual.priceWad?.toString() ?? null, v.midWad);
  assert.equal(actual.valid, v.valid);
  assert.equal(actual.bidDepthLots.toString(), v.bidDepthLots);
  assert.equal(actual.askDepthLots.toString(), v.askDepthLots);
});

test('canonical book aggregates duplicate fractional levels before flooring total depth', () => {
  const b = normalizeBook({ bids: [{price:'0.6',size:'0.0006'}, {price:'0.6',size:'0.0006'}],
    asks: [{price:'0.61',size:'5'}], tick_size:'0.01', min_order_size:'5' });
  const s = summarizeBook(b, 5000n, 50000000000000000n, 'vwap');
  assert.equal(s.bidDepthLots, 1n);
  assert.equal(s.valid, false);
  assert.equal(s.priceWad, null);
});

test('off-grid, malformed, out-of-domain and empty-sided books fail explicitly', () => {
  const raw = {bids:[{price:'0.6',size:'5'}],asks:[{price:'0.61',size:'5'}],tick_size:'0.01',min_order_size:'5'};
  for (const row of [{price:'0.605',size:'5'}, {price:'0.6',size:'-5'}, {price:'1.01',size:'5'}])
    assert.throws(() => normalizeBook({...raw,bids:[row]}));
  assert.throws(() => normalizeBook({...raw,bids:[]}));
});
