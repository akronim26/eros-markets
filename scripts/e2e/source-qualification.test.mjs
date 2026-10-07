import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSnapshot } from '../../packages/pricefeed/dist/src/collector.js';
import { SourceQualification, QUALIFICATION_DURATION_MS } from './source-qualification.mjs';

const start = 1_000_000, baseline = 'ab'.repeat(32);
const make = (startedAtMs = start, minimumHeadroomMs = 5000) => new SourceQualification({ startedAtMs,
  externalRulesDigest: '0x' + baseline, minimumHeadroomMs });
function poll(at, stamp = at, { status = 'COLLECTING', reason = null, valid = true, monotone = true, digest = baseline } = {}) {
  return { baselineRulesDigest: digest, atMs: BigInt(at - 10000), inspection: { status, reason,
    summary: { valid }, time: { sourceMs: BigInt(stamp), sourceAgeMs: BigInt(at - stamp), monotone } } };
}
const future = (at, options) => poll(at, at + 1, { status: 'DEGRADED', reason: 'STALE_OR_FUTURE_SOURCE_TIME', ...options });

test('actual collector future reason can hide thin depth; qualification rejects that capture', () => {
  const cfg = { mapping: { conditionId: 'condition', outcomeTokenId: '1' }, poll: { minimumHeadroomMs: 5000, metadataMaxAgeMs: 90000 },
    pricing: { depthNLots: '1000000', maxSpreadWad: '50000000000000000', impactMethod: 'vwap' } };
  const book = { market: 'condition', asset_id: '1', timestamp: String(start + 501), hash: 'vendor', tick_size: '0.01', min_order_size: '5',
    bids: [{ price: '0.50', size: '1' }], asks: [{ price: '0.51', size: '1' }] };
  const inspection = inspectSnapshot(cfg, book, BigInt(start + 500), BigInt(start),
    { tradeable: true, rulesDigest: baseline }, BigInt(start), baseline);
  assert.equal(inspection.reason, 'STALE_OR_FUTURE_SOURCE_TIME');
  assert.equal(inspection.summary.valid, false);
  const q = make(); q.observe(poll(start), start);
  assert.throws(() => q.observe({ baselineRulesDigest: baseline, inspection }, start + 500), /SOURCE_NOT_QUALIFIED/);
  assert.equal(q.lastSourceMs, start);
  assert.equal(q.failures, 1);
});

test('future tolerance requires exact status, monotonicity and valid depth without advancing accepted time', () => {
  const q = make(); q.observe(poll(start), start);
  q.observe(future(start + 500), start + 500);
  assert.equal(q.lastSourceMs, start); assert.equal(q.validPolls, 1); assert.equal(q.rejectedFuturePolls, 1);
  q.observe(poll(start + 1000), start + 1000);
  assert.equal(q.lastSourceMs, start + 1000);
  for (const change of [{ status: 'QUARANTINED' }, { monotone: false }, { valid: false }, { reason: 'SOURCE_NOT_TRADEABLE' }]) {
    const bad = make(); bad.observe(poll(start), start);
    assert.throws(() => bad.observe(future(start + 500, change), start + 500), /SOURCE_NOT_QUALIFIED/);
  }
  assert.throws(() => make().observe(future(start), start), /NO_CONTINUOUS/);
});

test('pinned candidate digest rejects a different first baseline and subsequent valid or future polls', () => {
  for (const first of [true, false]) for (const rejected of [true, false]) {
    const q = make(); if (!first) q.observe(poll(start), start);
    const result = rejected ? future(start + 1000, { digest: 'cd'.repeat(32) }) : poll(start + 1000, start + 1000, { digest: 'cd'.repeat(32) });
    assert.throws(() => q.observe(result, start + 1000), /CANDIDATE_BASELINE_RULES_CHANGED/);
    assert.equal(q.failures, 1);
  }
  const q = make(); q.observe(poll(start, start, { digest: '0x' + baseline.toUpperCase() }), start);
  assert.equal(q.validPolls, 1);
});

test('completion checks final wall-clock carry rather than stopping at the last healthy poll', () => {
  const q = make();
  for (let i = 0; i < 900; i++) q.observe(poll(start + i * 1000, start + Math.min(i, 875) * 1000), start + i * 1000);
  assert.equal(q.maxCarryMs, 24000);
  const result = q.snapshot(true, start + QUALIFICATION_DURATION_MS);
  assert.equal(result.maxCarryMs, 25000); assert.equal(result.passed, false);
  assert.equal(result.validPolls, 900); // Enough samples cannot hide an uncovered endpoint.
});

test('receipt timestamps exclude cold startup from the required fifteen-minute coverage', () => {
  const q = make(), first = start + 3000;
  for (let i = 0; i < 897; i++) q.observe(poll(first + i * 1000), first + i * 1000);
  const early = q.snapshot(true, start + QUALIFICATION_DURATION_MS);
  assert.equal(early.firstValidAt, new Date(first).toISOString()); // Ignores misleading PollResult.atMs.
  assert.equal(early.coverageDurationMs, 897000); assert.equal(early.passed, false);
  for (let i = 897; i < 900; i++) q.observe(poll(first + i * 1000), first + i * 1000);
  assert.equal(q.snapshot(true, first + QUALIFICATION_DURATION_MS).passed, true);
});

test('future polls do not count toward 800 valid observations and retain original headroom', () => {
  for (const validCount of [799, 800]) {
    const q = make();
    for (let i = 0; i < 900; i++) {
      // Distribute rejected captures so accepted-source carry remains covered.
      const reject = i % 9 === 8 || (validCount === 799 && i === 1);
      q.observe(reject ? future(start + i * 1000) : poll(start + i * 1000), start + i * 1000);
    }
    const result = q.snapshot(true, start + QUALIFICATION_DURATION_MS);
    assert.equal(result.validPolls, validCount); assert.equal(result.passed, validCount === 800);
    assert.equal(result.maxSourceGapMs, 25000); assert.match(result.scope, /not proof of accepted on-chain/);
  }
  const q = make(); q.observe(poll(start), start);
  assert.throws(() => q.observe(future(start + 25000), start + 25000), /NO_CONTINUOUS/);
  assert.equal(q.lastSourceMs, start);
});

test('receipt gaps, consumer delay and backwards clocks fail closed without changing source time', () => {
  const gap = make(); gap.observe(poll(start), start);
  assert.throws(() => gap.observe(poll(start + 26000), start + 26000), /NO_CONTINUOUS/);
  const delay = make();
  assert.throws(() => delay.observe(poll(start), start + 25000), /NO_CONTINUOUS/);
  const clock = make(); clock.observe(poll(start + 1000), start + 1000);
  assert.throws(() => clock.observe(poll(start + 500), start + 500), /CLOCK_MOVED_BACKWARDS/);
  assert.equal(clock.failures, 1);
});
