import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makerPerpPromotion } from './maker-sampling.mjs';

const engine = '0x1234', block = { number: 20n, hash: '0xabc', timestamp: 100n };
const eventLog = { address: engine, blockNumber: 20n, blockHash: block.hash,
  args: { t: 95n, valid: true, basisValid: true } };
const run = (logs, override = {}) => makerPerpPromotion({ engine, blockNumber: 20n, previous: 80n,
  client: { getBlock: async () => block, getLogs: async () => logs, ...override } });

test('only a sealed valid PERP/BASIS event advances maker maintenance timing', async () => {
  assert.equal(await run([eventLog]), 95n);
  assert.equal(await run([]), 80n);
  assert.equal(await run([{ ...eventLog, args: { ...eventLog.args, valid: false } }]), 80n);
  assert.equal(await run([{ ...eventLog, args: { ...eventLog.args, basisValid: false } }]), 80n);
});

test('maker promotion rejects events from another block or engine and nonfinalized samples', async () => {
  for (const changed of [{ address: '0xabcd' }, { blockHash: '0xdef' }, { blockNumber: 19n },
    { args: { ...eventLog.args, t: 101n } }])
    await assert.rejects(run([{ ...eventLog, ...changed }]), /IDENTITY_MISMATCH/);
  await assert.rejects(run([eventLog], { getBlock: async request => request.blockTag ? { ...block, number: 19n } : block }), /NOT_FINALIZED/);
});
