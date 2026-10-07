import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCanonicalSampleCapture } from './sample-capture.mjs';
const engine = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const log = block => ({ address: engine, blockNumber: block, blockHash: hash, args: { observedBlock: block, observedAt: 150n } });
const rpc = events => ({
  getBlock: async ({ blockNumber = 20n }) => ({ number: blockNumber, hash, timestamp: 200n }),
  getLogs: async ({ fromBlock }) => events(fromBlock),
});
test('sample acknowledgement uses the capture event rather than receipt time', async () => {
  const result = await readCanonicalSampleCapture({ client: rpc(b => [log(b)]), engine, event: {}, blockNumber: 10n });
  assert.deepEqual(result, { captureVersion: 1, sampledAt: '150', sampledBlock: '10', sampledBlockHash: hash });
});
test('a no-op sample preserves a verified earlier capture and ignores legacy receipt-time acknowledgements', async () => {
  const client = rpc(b => b === 10n ? [log(b)] : []);
  const previous = { engine, captureVersion: 1, sampledAt: '150', sampledBlock: '10', sampledBlockHash: hash };
  assert.equal((await readCanonicalSampleCapture({ client, engine, event: {}, blockNumber: 11n, previous })).sampledAt, '150');
  assert.equal((await readCanonicalSampleCapture({ client, engine, event: {}, blockNumber: 11n, previous: { engine, sampledAt: '200' } })).sampledAt, null);
  await assert.rejects(readCanonicalSampleCapture({ client, engine, event: {}, blockNumber: 11n, previous: { ...previous, sampledAt: '151' } }), /ACK_MISMATCH/);
});
test('unfinalized, reorganized or mismatched capture events cannot acknowledge a capture', async () => {
  const unfinalized = rpc(b => [log(b)]);
  unfinalized.getBlock = async ({ blockNumber = 9n }) => ({ number: blockNumber, hash, timestamp: 200n });
  await assert.rejects(readCanonicalSampleCapture({ client: unfinalized, engine, event: {}, blockNumber: 10n }), /NOT_FINALIZED/);
  const changed = rpc(b => [log(b)]); let reads = 0;
  changed.getBlock = async ({ blockNumber = 20n }) => ({ number: blockNumber, hash: ++reads > 2 ? `0x${'cd'.repeat(32)}` : hash, timestamp: 200n });
  await assert.rejects(readCanonicalSampleCapture({ client: changed, engine, event: {}, blockNumber: 10n }), /NONCANONICAL/);
  await assert.rejects(readCanonicalSampleCapture({ client: rpc(b => [{ ...log(b), args: { observedBlock: b, observedAt: 201n } }]), engine, event: {}, blockNumber: 10n }), /IDENTITY_MISMATCH/);
});
