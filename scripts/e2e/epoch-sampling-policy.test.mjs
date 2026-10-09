import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epochSamplingPolicy, readEpochSamplingPolicy, requireSampleSigningWindow, SampleEpochDeferred } from './epoch-sampling-policy.mjs';
import { sampleCadenceRemaining } from './sampler-request-policy.mjs';

const end = 1791374400n;
const at = (remaining, cadence = 45n) => epochSamplingPolicy({ timestamp: end - BigInt(remaining), epochEnd: end, cadence, nowMs: Number(end - BigInt(remaining)) * 1000 });

test('leaves source/finality delivery headroom in steady state and accelerates final capture without relaxing inclusion', () => {
  assert.equal(at(61).cadence, 24n);
  assert.equal(at(60).cadence, 12n);
  assert.equal(at(21).cadence, 12n);
  assert.equal(at(20).cadence, 1n);
  assert.equal(at(9, 30n).cadence, 1n);
  assert.equal(at(30, 5n).cadence, 5n);
  assert.equal(at(61, 5n).cadence, 5n);
  assert.equal(at(9).admit, true);
  for (const seconds of [8, 7, 0, -2]) assert.equal(at(seconds).admit, false);
});

test('slow preparation crossing the inclusion reserve refuses before signing', async () => {
  let now = Number(end - 12n) * 1000, signed = false;
  const client = {
    async getBlock() { return { number: 10n, hash: 'canonical', timestamp: end - 12n }; },
    async readContract({ blockNumber }) { assert.equal(blockNumber, 10n); now = Number(end - 7n) * 1000; return [1n, 0n, end]; },
  };
  await assert.rejects(async () => {
    await requireSampleSigningWindow({ client, engine: 'engine', abi: [], cadence: 45n, now: () => now });
    signed = true;
  }, error => error instanceof SampleEpochDeferred && error.message === 'SAMPLE_EPOCH_CLOSING');
  assert.equal(signed, false);
});

test('uses the actual block-pinned epoch and rejects a reorg rather than authorizing from a cached deadline', async () => {
  let canonical = 'canonical';
  const client = {
    async getBlock(options) { return { number: 11n, hash: options ? canonical : 'canonical', timestamp: end - 20n }; },
    async readContract({ functionName, blockNumber }) { assert.equal(functionName, 'epoch'); assert.equal(blockNumber, 11n); return [2n, 0n, end + 3600n]; },
  };
  const options = { client, engine: 'engine', abi: [], cadence: 30n, now: () => Number(end - 20n) * 1000 };
  const policy = await readEpochSamplingPolicy(options);
  assert.equal(policy.epochEnd, end + 3600n);
  assert.equal(policy.cadence, 24n);
  canonical = 'fork';
  await assert.rejects(requireSampleSigningWindow(options), /SAMPLE_EPOCH_BLOCK_CHANGED/);
});

test('the observed 12:00:02 late sample is rejected and the final-minute next capture is eligible sooner', () => {
  assert.equal(at(-2).admit, false);
  const capturedAtBlock = 68964502n;
  const shortlyAfter = capturedAtBlock + 12n;
  assert.ok(sampleCadenceRemaining(String(capturedAtBlock), shortlyAfter, 45n) > 0n);
  assert.equal(sampleCadenceRemaining(String(capturedAtBlock), shortlyAfter, at(14).cadence), 0n);
  assert.equal(at(14).admit, true);
});

test('a delayed coordinated request no longer waits the old 45-block floor after source finality', () => {
  const last = 100n, now = 124n;
  assert.ok(sampleCadenceRemaining(String(last), now, 45n) > 0n);
  assert.equal(sampleCadenceRemaining(String(last), now, at(120).cadence), 0n);
  assert.equal(sampleCadenceRemaining(String(last), 101n, at(12).cadence), 0n);
  assert.equal(at(8).admit, false);
});
