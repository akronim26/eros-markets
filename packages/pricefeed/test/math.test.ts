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

test('selected book-price VWAP respects source minimum at one-lot boundaries', () => {
  const book=normalizeBook({bids:[{price:'0.60',size:'6'}],asks:[{price:'0.62',size:'6'}],
    tick_size:'0.01',min_order_size:'5'});
  const below=summarizeBook(book,4999n,50000000000000000n,'vwap');
  assert.equal(below.valid,false);
  assert.equal(below.reason,'BELOW_SOURCE_MINIMUM');
  assert.equal(below.priceWad,null);
  for(const n of [5000n,5001n]){
    const summary=summarizeBook(book,n,50000000000000000n,'vwap');
    assert.equal(summary.valid,true);
    assert.equal(summary.impactBidWad,600000000000000000n);
    assert.equal(summary.impactAskWad,620000000000000000n);
    assert.equal(summary.priceWad,610000000000000000n);
    assert.equal(summary.bidDepthLots,6000n);
    assert.equal(summary.askDepthLots,6000n);
  }
});

test('selected depth policy preserves residual quantity without rounding depth up', () => {
  const book=normalizeBook({bids:[{price:'0.60',size:'5'},{price:'0.58',size:'0.0008'}],
    asks:[{price:'0.62',size:'5'},{price:'0.64',size:'0.0008'}],tick_size:'0.01',min_order_size:'5'});
  const atN=summarizeBook(book,5000n,50000000000000000n,'vwap');
  assert.equal(atN.valid,true);
  assert.equal(atN.bidDepthLots,5000n);
  assert.equal(atN.askDepthLots,5000n);
  assert.equal(atN.priceWad,610000000000000000n);
  const oneLotMore=summarizeBook(book,5001n,50000000000000000n,'vwap');
  assert.equal(oneLotMore.valid,false);
  assert.equal(oneLotMore.reason,'INSUFFICIENT_DEPTH');
  assert.equal(oneLotMore.priceWad,null);
});
