import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { candidateEligible, createLiveSource, LIVE_EROS_RULES_PREFIX, probeSummary, readLiveSource, sourceConfig } from '../scripts/live-factory-source.js';
import { livePublicationDecision, liveSamplingAcknowledgement, liveSamplingWindow, provisionalSamplerCapture } from '../scripts/live-factory-integration.js';
import type { DiscoveryCandidate } from '../src/discovery.js';
import type { PollResult } from '../src/worker.js';

const candidate = (now: number): DiscoveryCandidate => ({ category: 'crypto', eventId: '1', externalMarketId: '2',
  conditionId: '0x' + '12'.repeat(32), title: 'Event', question: 'Will the event occur?', description: 'Resolve under retained source rules.',
  resolutionSource: 'https://example.invalid/source', sourceEndDate: new Date(now + 7 * 86400000).toISOString(),
  outcomes: [{ label: 'Yes', tokenId: '3' }, { label: 'No', tokenId: '4' }], selectedOutcome: null, enabled: false,
  mappingApproved: false, status: 'REVIEW_REQUIRED', reasons: [], sourcePageSha256: 'a'.repeat(64), sourceEvidenceSha256: 'b'.repeat(64) });
const snapshot = (sourceMs: bigint, atMs: bigint, status = 'COLLECTING'): PollResult => ({
  inspection: { status, reason: status === 'INVALID_DEPTH' ? 'THIN_BOOK' : null,
    time: { sourceMs, observedAt: sourceMs / 1000n }, summary: { priceWad: 500000000000000000n } }, atMs,
}) as unknown as PollResult;

test('live candidate requires actual binary mapping, complete rules and a genuine 25h to29d horizon', () => {
  const now = 1800000000000, value = candidate(now);
  assert.equal(candidateEligible(value, now), true);
  for (const changed of [
    { ...value, sourceEndDate: new Date(now + 24 * 3600000).toISOString() },
    { ...value, sourceEndDate: new Date(now + 30 * 86400000).toISOString() },
    { ...value, reasons: ['NEGATIVE_RISK_REQUIRES_REVIEW'] },
    { ...value, description: null }, { ...value, outcomes: [{ label: 'A', tokenId: '3' }, { label: 'B', tokenId: '4' }] },
  ]) assert.equal(candidateEligible(changed, now), false);
  const cfg = sourceConfig(value);
  assert.equal(cfg.enabled, false); assert.equal(cfg.destination, null);
  assert.equal(cfg.poll.intervalMs, 1000);
  assert.equal(cfg.pricing.depthNLots, '1000000'); assert.equal(cfg.pricing.maxSpreadWad, '50000000000000000');
});

test('full120second source probe requires repeated genuine timestamp advancement, not repolling unchanged time', () => {
  const results = Array.from({ length: 24 }, (_, i) => snapshot(1800000000000n + BigInt(i * 5000), 1800000001000n + BigInt(i * 5000)));
  assert.equal(probeSummary(results, 120000).advances, 23);
  assert.throws(() => probeSummary(results, 119999), /TOO_SHORT/);
  const quiet = results.map(result => snapshot(1800000000000n, result.atMs));
  assert.throws(() => probeSummary(quiet, 120000), /SOURCE_AGE|TOO_QUIET/);
  const gapped = results.map((result, i) => i < 10 ? result : snapshot(result.inspection.time!.sourceMs + 21000n, result.atMs + 21000n));
  assert.throws(() => probeSummary(gapped, 120000), /TOO_QUIET/);
});

test('live source diagnostics reject stale, invalid or noninterior price captures without synthetic fallback', () => {
  const results = Array.from({ length: 24 }, (_, i) => snapshot(1800000000000n + BigInt(i * 5000), 1800000001000n + BigInt(i * 5000)));
  results[10] = snapshot(1800000050000n, 1800000051000n, 'INVALID_DEPTH');
  assert.throws(() => probeSummary(results, 120000), /UNSUITABLE/);
});

test('immutable live listing binds retained description, source mapping and genuine scheduled time', () => {
  const now = 1800000000000, value = candidate(now), cfg = sourceConfig(value);
  const result = { ...snapshot(BigInt(now), BigInt(now)),
    metadata: { data: { id: value.externalMarketId, conditionId: value.conditionId, outcomes: ['Yes', 'No'],
      clobTokenIds: ['3', '4'], question: value.question, description: value.description,
      resolutionSource: value.resolutionSource, endDate: value.sourceEndDate } },
    event: { data: { id: value.eventId, markets: [{ id: value.externalMarketId }] } },
  } as unknown as PollResult;
  const source = createLiveSource(value, cfg, result, { durationMs: 120000, captures: 24, advances: 23, maximumAdvanceGapMs: '5000' }, BigInt(now), '00000000-0000-4000-8000-000000000001');
  assert.equal(source.erosRulesHash, keccak256(stringToHex(LIVE_EROS_RULES_PREFIX + value.description)));
  const directory = mkdtempSync(join(tmpdir(), 'live-source-binding-')), path = join(directory, 'source.json');
  try {
    const write = (changed: unknown) => writeFileSync(path, JSON.stringify(changed));
    write(source); assert.equal(readLiveSource(path).marketId, source.marketId);
    write({ ...source, description: 'changed adjudication text' }); assert.throws(() => readLiveSource(path), /METADATA_CHANGED/);
    write({ ...source, scheduledT: String(BigInt(source.scheduledT) + 1n) }); assert.throws(() => readLiveSource(path), /MANIFEST_CHANGED/);
    write({ ...source, config: { ...source.config, mapping: { ...cfg.mapping, outcomeTokenId: '4' } } });
    assert.throws(() => readLiveSource(path), /MAPPING_CHANGED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('live prefix coordination holds same-second and older source observations without altering archived times', () => {
  const original = snapshot(100999n, 102000n), before = structuredClone(original);
  assert.deepEqual(livePublicationDecision(original, 100n, null), { publish: false, reason: 'WAIT_FOR_AUTHENTIC_INDEX_PREFIX_SEAL' });
  assert.equal(livePublicationDecision(snapshot(101000n, 102000n), 100n, null).publish, true);
  assert.deepEqual(original, before);
});

test('invalid depth interrupts capture validity immediately; duplicate vendor time cannot extend expiry', () => {
  assert.equal(livePublicationDecision(snapshot(100999n, 102000n, 'INVALID_DEPTH'), 101n, null).publish, true);
  assert.deepEqual(livePublicationDecision(snapshot(100999n, 102000n), null, 100999n),
    { publish: false, reason: 'SOURCE_TIMESTAMP_NOT_ADVANCED' });
  assert.equal(livePublicationDecision(snapshot(100999n, 102000n, 'QUARANTINED'), null, null).publish, false);
});

test('live pause acknowledges its observed request only after sampler work drains', () => {
  const control = { pauseSampling: true, pauseRequestId: 'request-b' };
  assert.deepEqual(liveSamplingAcknowledgement(control, true), { samplingPaused: false, samplingPauseRequestId: null });
  assert.deepEqual(liveSamplingAcknowledgement(control, false), { samplingPaused: true, samplingPauseRequestId: 'request-b' });
});

test('stale live pause acknowledgement cannot satisfy a new request across resume', () => {
  const stale = liveSamplingAcknowledgement({ pauseSampling: true, pauseRequestId: 'request-a' }, false);
  assert.deepEqual(liveSamplingAcknowledgement({ pauseSampling: false, pauseRequestId: 'request-a' }, false),
    { samplingPaused: false, samplingPauseRequestId: null });
  assert.notEqual(stale.samplingPauseRequestId, 'request-b');
  const current = liveSamplingAcknowledgement({ pauseSampling: true, pauseRequestId: 'request-b' }, false);
  assert.equal(current.samplingPauseRequestId, 'request-b');
});

test('live legacy stop controls remain valid but malformed pause IDs fail closed', () => {
  assert.deepEqual(liveSamplingAcknowledgement({ pauseSampling: true, stop: true }, false),
    { samplingPaused: true, samplingPauseRequestId: null });
  for (const pauseRequestId of ['', 3, null, 'x'.repeat(129)])
    assert.throws(() => liveSamplingAcknowledgement({ pauseSampling: true, pauseRequestId }, false), /REQUEST_ID_REQUIRED/);
});

const armed = { pauseSampling: true, pauseRequestId: 'epoch-100', minimumCaptureTime: '85', epochEnd: '100' };
const sealed = (t: string, timestamp: string, valid = true) => ({ observation: { t, valid }, timestamp });
test('armed pause waits for a qualifying valid pre-boundary seal and drained sampler', () => {
  for (const sample of [undefined, sealed('84', '92'), sealed('85', '92', false), sealed('85', '100'), sealed('100', '100'),
    { observation: { t: '85', valid: true } }])
    assert.equal(liveSamplingAcknowledgement(armed, false, sample).samplingPaused, false);
  assert.equal(liveSamplingAcknowledgement(armed, true, sealed('85', '96')).samplingPaused, false);
  assert.deepEqual(liveSamplingAcknowledgement(armed, false, sealed('85', '96')),
    { samplingPaused: true, samplingPauseRequestId: 'epoch-100' });
});

test('armed capture scheduling reserves a drain interval then samples only before the epoch safety cutoff', () => {
  assert.equal(liveSamplingWindow(armed, 77n, 100n), true);
  for (const t of [78n, 80n, 84n]) assert.equal(liveSamplingWindow(armed, t, 100n), false);
  for (const t of [85n, 86n, 95n]) assert.equal(liveSamplingWindow(armed, t, 100n), true);
  for (const t of [96n, 100n, 101n]) assert.equal(liveSamplingWindow(armed, t, 100n), false);
  assert.throws(() => liveSamplingWindow(armed, 85n, 200n), /ARMED_EPOCH_CHANGED/);
});

test('armed pause rejects partial, unbound or wider freshness budgets', () => {
  for (const request of [{ ...armed, epochEnd: undefined }, { ...armed, minimumCaptureTime: '84' },
    { ...armed, pauseRequestId: undefined }, { ...armed, pauseSampling: false }, { ...armed, minimumCaptureTime: '-1' }])
    assert.throws(() => liveSamplingAcknowledgement(request, false), /ARMED_WINDOW_INVALID/);
});

const captureAbi = parseAbi(['event BookDepthCaptured(uint64 observedAt,uint256 observedBlock,uint16 examined,bytes32 fingerprint)']);
const pendingHash = '0x' + '11'.repeat(32), captureEngine = '0x' + '22'.repeat(20), captureBlockHash = '0x' + '33'.repeat(32);
const captureBlock = { number: 10n, timestamp: 100n, hash: captureBlockHash };
const captureLog = (t = 100n, block = 10n) => ({ address: captureEngine,
  topics: encodeEventTopics({ abi: captureAbi, eventName: 'BookDepthCaptured' }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint16' }, { type: 'bytes32' }],
    [t, block, 2, ('0x' + '44'.repeat(32)) as Hex]) });
const captureReceipt = () => ({ transactionHash: pendingHash, status: 'success', blockNumber: 10n,
  blockHash: captureBlockHash, logs: [captureLog()] });

test('only the exact canonical pending sampler receipt can protect a provisional INDEX prefix', () => {
  const receipt = captureReceipt(), before = structuredClone(receipt);
  assert.deepEqual(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, receipt, captureBlock),
    { observedAt: '100', observedBlock: '10', transactionHash: pendingHash, blockHash: captureBlockHash });
  assert.deepEqual(receipt, before);
  assert.equal(provisionalSamplerCapture('0x' + '55'.repeat(32), captureEngine, captureAbi, receipt, captureBlock), null);
});

test('missing and reverted pending sampler receipts cannot authorize overlapping publication', () => {
  assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, null, captureBlock), null);
  assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, captureReceipt(), null), null);
  assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi,
    { ...captureReceipt(), status: 'reverted' }, captureBlock), null);
});

test('a removed or replacement receipt block invalidates provisional prefix protection', () => {
  assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, captureReceipt(),
    { ...captureBlock, hash: '0x' + '66'.repeat(32) }), null);
  assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, captureReceipt(),
    { ...captureBlock, number: 11n }), null);
});

test('absent, foreign-engine or ambiguous capture logs do not substitute for the pending engine capture', () => {
  for (const logs of [[], [{ ...captureLog(), address: '0x' + '77'.repeat(20) }], [captureLog(), captureLog()]])
    assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, { ...captureReceipt(), logs }, captureBlock), null);
});

test('a provisional capture must contain actual receipt-block time and height and decodable event data', () => {
  for (const log of [captureLog(99n), captureLog(100n, 9n), { ...captureLog(), data: '0x' as Hex }])
    assert.equal(provisionalSamplerCapture(pendingHash, captureEngine, captureAbi,
      { ...captureReceipt(), logs: [log] }, captureBlock), null);
});

test('provisional INDEX overlap refuses same-second, older and invalid-depth snapshots until they are strictly newer', () => {
  const before = snapshot(100999n, 102000n);
  for (const result of [before, snapshot(99999n, 102000n), snapshot(100999n, 102000n, 'INVALID_DEPTH')])
    assert.equal(livePublicationDecision(result, 100n, null, true).publish, false);
  assert.equal(livePublicationDecision(snapshot(101000n, 102000n), 100n, null, true).publish, true);
  assert.equal(livePublicationDecision(snapshot(101000n, 102000n, 'INVALID_DEPTH'), 100n, null, true).publish, true);
  assert.equal(before.inspection.time!.sourceMs, 100999n);
});

test('provisional capture cannot acknowledge pause even when a prior sealed sample meets the armed target', () => {
  const receipt = captureReceipt(), protectedCapture = provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, receipt, captureBlock);
  assert.ok(protectedCapture);
  assert.deepEqual(liveSamplingAcknowledgement(armed, true, sealed('85', '96')),
    { samplingPaused: false, samplingPauseRequestId: null });
});

test('finality drain preserves the same capture identity before sampling or pause acknowledgement can continue', () => {
  const provisional = provisionalSamplerCapture(pendingHash, captureEngine, captureAbi, captureReceipt(), captureBlock)!;
  const finalizedCapture = { observedAt: '100', observedBlock: '10', transactionHash: pendingHash };
  assert.deepEqual({ observedAt: provisional.observedAt, observedBlock: provisional.observedBlock,
    transactionHash: provisional.transactionHash }, finalizedCapture);
  assert.equal(livePublicationDecision(snapshot(101000n, 102000n), BigInt(finalizedCapture.observedAt), null).publish, true);
  assert.deepEqual(liveSamplingAcknowledgement(armed, false, sealed('85', '96')),
    { samplingPaused: true, samplingPauseRequestId: 'epoch-100' });
});
