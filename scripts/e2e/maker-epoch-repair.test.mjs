import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { verifyRepairCalldata, repairReceiptOutcome, makerOwnerOrder, makerLoopDelay, simulateEpochRepair } from './maker-epoch-repair.mjs';
const require = createRequire(new URL('../../packages/pricefeed/package.json', import.meta.url));
const { encodeFunctionData, decodeFunctionData, parseTransaction, keccak256 } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const abi = JSON.parse(fs.readFileSync(new URL('../../artifacts/risk/book-risk-engine-abi.json', import.meta.url))).abi;
const pending = { action: 'epochRepair', functionName: 'batch', hash: '0xquote', cancelIds: [17], side: 'buy', epoch: '8', tick: 85, size: '2000000' };
const place = { kind: 2, isBuy: true, reduceOnly: false, tick: 85, size: 2000000n, maxFills: 8, expiryBlock: 0 };
const cancelled = { eventName: 'OrderCancelled', args: { id: 17, size: 2000000n, reason: 0 } };
const placed = { eventName: 'OrderPlaced', args: { id: 16777233, trader: 1, tick: 85, size: 2000000n, flags: 5 } };
const input = { pending, events: [cancelled, placed], orders: [{ size: 0n, flags: 0 }], trader: 1, owner: 'owner', at: 1000 };

test('unsigned crossing selects cancel-only fallback while RPC and owner errors stop', async () => {
  assert.equal(await simulateEpochRepair(async () => ({ result: [0] })), null);
  assert.equal(await simulateEpochRepair(async () => { throw { cause: { data: { errorName: 'PostOnlyCrosses' } } }; }), null);
  assert.deepEqual(await simulateEpochRepair(async () => ({ result: [123] })), { result: [123] });
  await assert.rejects(simulateEpochRepair(async () => { throw Error('RPC_POOL_UNAVAILABLE'); }), /RPC_POOL_UNAVAILABLE/);
  await assert.rejects(simulateEpochRepair(async () => { throw Object.assign(Error('NotOwner'), { data: { errorName: 'NotOwner' } }); }), /NotOwner/);
  await assert.rejects(simulateEpochRepair(async () => ({ result: [] })), /SIMULATION_MISMATCH/);
});

test('atomic repair proves both old generation removal and exact new post-only quote', () => {
  const result = repairReceiptOutcome(input);
  assert.deepEqual(result.cleanup.cancelIds, [17]);
  assert.equal(result.quote.kind, 'completed');
  assert.equal(result.quote.record.orderId, 16777233);
  assert.throws(() => repairReceiptOutcome({ ...input, orders: [{ size: 1n, flags: 5 }] }), /STILL_LIVE/);
  assert.throws(() => repairReceiptOutcome({ ...input, events: [cancelled, { ...placed, args: { ...placed.args, trader: 2 } }] }), /PLACEMENT_MISMATCH/);
  assert.throws(() => repairReceiptOutcome({ ...input, events: [cancelled, { ...placed, args: { ...placed.args, size: 1n } }] }), /PLACEMENT_MISMATCH/);
});

test('post-only crossing after simulation retains cancellation and rejected quote without another signed nonce', () => {
  const result = repairReceiptOutcome({ ...input, events: [cancelled] });
  assert.deepEqual(result.cleanup.removedIds, [17]);
  assert.equal(result.quote.kind, 'rejected');
  assert.equal(result.quote.record.reason, 'post-only-skipped');
  assert.equal(result.quote.record.hash, pending.hash);
  assert.equal(result.cleanup.hash, pending.hash);
  assert.throws(() => repairReceiptOutcome({ ...input, events: [{ ...cancelled, args: { ...cancelled.args, id: 18 } }] }), /CANCEL_MISMATCH/);
});

test('restart validates the exact saved signed repair bytes, including post-only and cancel target', async () => {
  const account = privateKeyToAccount('0x' + '01'.repeat(32)); // Public, local-only fixture key.
  const data = encodeFunctionData({ abi, functionName: 'batch', args: [[17], [place]] });
  const raw = await account.signTransaction({ chainId: 10143, nonce: 0, type: 'eip1559',
    to: '0x' + '22'.repeat(20), data, gas: 1000000n, maxFeePerGas: 150000000000n, maxPriorityFeePerGas: 2000000000n });
  const saved = JSON.parse(JSON.stringify({ ...pending, raw, hash: keccak256(raw) }));
  const decoded = decodeFunctionData({ abi, data: parseTransaction(saved.raw).data });
  assert.doesNotThrow(() => verifyRepairCalldata(saved, decoded));
  for (const change of [{ kind: 1 }, { reduceOnly: true }, { isBuy: false }, { tick: 86 }, { size: 1n }, { maxFills: 9 }, { expiryBlock: 1 }])
    assert.throws(() => verifyRepairCalldata(saved, { functionName: 'batch', args: [[17], [{ ...place, ...change }]] }), /CALLDATA_MISMATCH/);
  assert.throws(() => verifyRepairCalldata({ ...saved, cancelIds: [18] }, decoded), /CALLDATA_MISMATCH/);
  assert.throws(() => verifyRepairCalldata(saved, { functionName: 'batch', args: [[17], []] }), /CALLDATA_MISMATCH/);
});

test('a finalized owner yields to its peer; pending outbox reconciliation avoids the idle delay', () => {
  const owners = [['buy', 'alice'], ['sell', 'bob']];
  assert.deepEqual(makerOwnerOrder(owners, 'sell'), [owners[1], owners[0]]);
  assert.deepEqual(makerOwnerOrder(owners, 'buy'), owners);
  assert.equal(makerLoopDelay({ pending: true, progressed: false }), 1000);
  assert.equal(makerLoopDelay({ pending: false, progressed: true }), 0);
  assert.equal(makerLoopDelay({ pending: false, progressed: false }), 3000);
});
