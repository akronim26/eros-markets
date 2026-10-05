import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLiveClock, liveClockBounds, validateLiveMonadCapture, validateLiveMonadChain,
  validateLiveTimeCapture, type ClockCapture } from '../scripts/live-clock.js';

const second = 1800000000;
const capture = (body = String(second), offset = 0, elapsed = 200): ClockCapture => ({
  url: 'https://clob.polymarket.com/time', startedAtMs: second * 1000 + 400 + offset,
  receivedAtMs: second * 1000 + 400 + offset + elapsed, rttMs: elapsed, status: 200, body,
  bodySha256: createHash('sha256').update(body).digest('hex'),
});
const rpc = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
const block = (seconds = second) => ({ timestamp: '0x' + seconds.toString(16), number: '0x123', hash: '0x' + '12'.repeat(32) });

test('live clock accepts synchronized positive and negative offsets with complete RTT and quantization bounds', () => {
  assert.deepEqual(validateLiveTimeCapture(capture()), { earliestOffsetMs: -600, latestOffsetMs: 600 });
  assert.deepEqual(validateLiveTimeCapture(capture(String(second), 800)), { earliestOffsetMs: -1400, latestOffsetMs: -200 });
  assert.deepEqual(validateLiveTimeCapture(capture(String(second), -800)), { earliestOffsetMs: 200, latestOffsetMs: 1400 });
});
test('live clock rejects host clocks ahead or behind even when a midpoint would look acceptable', () => {
  for (const offset of [901, -901, 4180, -4180]) assert.throws(() => validateLiveTimeCapture(capture(String(second), offset)), /HOST_SKEW/);
});
test('live clock rejects slow responses, backwards time and wallclock changes during transport', () => {
  assert.throws(() => validateLiveTimeCapture(capture(String(second), 0, 1001)), /RTT_TOO_HIGH/);
  assert.throws(() => validateLiveTimeCapture({ ...capture(), receivedAtMs: second * 1000 }), /INVALID_TIMING/);
  assert.throws(() => validateLiveTimeCapture({ ...capture(), rttMs: 50 }), /WALL_JUMP/);
  assert.throws(() => validateLiveTimeCapture({ ...capture(), rttMs: Number.NaN }), /INVALID_TIMING/);
});
test('live clock rejects wrong units, malformed body, strings and non-200 source responses', () => {
  for (const body of [String(second * 1000), String(second * 1000000), '1800000000.5', '"1800000000"', '{}', 'null', '0'])
    assert.throws(() => validateLiveTimeCapture(capture(body)), /SECONDS_REQUIRED/);
  assert.throws(() => validateLiveTimeCapture(capture('invalid')), SyntaxError);
  assert.throws(() => validateLiveTimeCapture({ ...capture(), status: 503 }), /HTTP_FAILED/);
  assert.throws(() => liveClockBounds(capture(), Number.MAX_SAFE_INTEGER), /SECONDS_REQUIRED/);
});
test('independent Monad corroboration requires chain10143 and a recent canonical-shaped block identity', () => {
  validateLiveMonadChain(capture(rpc('0x279f')));
  assert.throws(() => validateLiveMonadChain(capture(rpc('0x1'))), /MONAD_CHAIN_REQUIRED/);
  const result = validateLiveMonadCapture(capture(rpc(block())));
  assert.equal(result.blockHash, block().hash); assert.equal(result.blockNumber, '291');
  assert.throws(() => validateLiveMonadCapture(capture(rpc(block(second - 6)))), /STALE_OR_FUTURE/);
  assert.throws(() => validateLiveMonadCapture(capture(rpc(block(second + 2)))), /STALE_OR_FUTURE/);
  for (const value of [null, { ...block(), timestamp: String(second) }, { ...block(), hash: '0x12' }, { ...block(), number: null }])
    assert.throws(() => validateLiveMonadCapture(capture(rpc(value))), /BLOCK_INVALID/);
  assert.throws(() => validateLiveMonadCapture(capture(JSON.stringify({ jsonrpc: '2.0', id: 2, result: block() }))), /RPC_FAILED/);
});
test('clock preflight persists all three independent samples without signing or mutating clocks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-clock-'));
  try {
    const output = join(directory, 'clock.json'), requests: string[] = [];
    await checkLiveClock(output, async (url, init) => {
      requests.push(url);
      if (url.endsWith('/time')) return capture();
      const method = JSON.parse(String(init!.body)).method;
      return capture(rpc(method === 'eth_chainId' ? '0x279f' : block()));
    });
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.passed, true); assert.equal(report.transactionsSent, 0); assert.equal(report.systemClockChanged, false);
    assert.equal(report.captures.length, 7); assert.equal(requests.filter(url => url.endsWith('/time')).length, 3);
    assert.ok(report.captures.every((value: { capture: ClockCapture }) => value.capture.bodySha256));
  } finally { rmSync(directory, { recursive: true }); }
});
test('clock preflight fails closed on any unavailable or skewed sample and preserves failure evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-clock-rejected-'));
  try {
    const output = join(directory, 'clock.json'); let requests = 0;
    await assert.rejects(checkLiveClock(output, async () => {
      if (++requests === 1) throw new Error('NETWORK_UNAVAILABLE');
      return capture(String(second), 4180);
    }), /PREFLIGHT_FAILED/);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.passed, false); assert.equal(report.captures.length, 7);
    assert.equal(report.captures[0].error, 'NETWORK_UNAVAILABLE'); assert.equal(report.captures[1].error, 'LIVE_CLOCK_HOST_SKEW');
  } finally { rmSync(directory, { recursive: true }); }
});
