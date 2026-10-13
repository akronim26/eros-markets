import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifiedMakerQuote, staleMakerOrder, cleanupReceiptOutcome, verifyCleanupCalldata, cleanupIds,
  MAKER_CLEANUP_MAX_BATCH } from './maker-cleanup.mjs';

const history = { hash: '0xabc', side: 'sell', epoch: '1', tick: 85 };
const placed = { eventName: 'OrderPlaced', args: { id: 17, trader: 2, tick: 85, flags: 4, size: 2_000_000n } };
const context = { trader: 2, side: 'sell', epoch: 2n, accountEpoch: 4n, blockNumber: 100n };
const oldOrder = { owner: 2, tick: 85, flags: 4, size: 2_000_000n, marketEpoch: 1n, accountEpoch: 3n, expiryBlock: 0 };
const emptyOrder = { owner: 0, flags: 0, size: 0n };
const verified = verifiedMakerQuote(history, [placed], 2, '0xowner', 1000);

test('legacy journal IDs are recovered only from matching canonical placement evidence', () => {
  assert.equal(verified.orderId, 17); assert.equal(verified.owner, '0xowner');
  assert.equal(verified.hash, history.hash); assert.equal(verified.epoch, history.epoch);
  for (const change of [{ trader: 3 }, { tick: 86 }, { flags: 5 }, { size: 0n }])
    assert.throws(() => verifiedMakerQuote(history, [{ ...placed, args: { ...placed.args, ...change } }], 2, '0xowner', 1000), /RECEIPT_MISMATCH/);
  assert.throws(() => verifiedMakerQuote({ ...history, orderId: 18 }, [placed], 2, '0xowner', 1000), /RECEIPT_MISMATCH/);
  assert.throws(() => verifiedMakerQuote(history, [placed, placed], 2, '0xowner', 1000), /RECEIPT_MISMATCH/);
});

test('cleanup selects the stale physical ask while preserving current live quotes and other owners', () => {
  assert.equal(staleMakerOrder(oldOrder, verified, context), true);
  const current = { ...oldOrder, marketEpoch: 2n, accountEpoch: 4n, tick: 105 };
  assert.equal(staleMakerOrder(current, { ...verified, tick: 105 }, context), false);
  assert.equal(staleMakerOrder({ ...current, expiryBlock: 99 }, { ...verified, tick: 105 }, context), true);
  assert.equal(staleMakerOrder({ ...current, expiryBlock: 100 }, { ...verified, tick: 105 }, context), false);
  assert.equal(staleMakerOrder(emptyOrder, verified, context), false);
  assert.throws(() => staleMakerOrder({ ...oldOrder, owner: 3 }, verified, context), /ORDER_MISMATCH/);
  assert.throws(() => staleMakerOrder({ ...oldOrder, flags: 5 }, verified, context), /ORDER_MISMATCH/);
});

test('cleanup outbox admits only bounded unique exact cancel IDs with no placements', () => {
  const pending = { functionName: 'batch', cancelIds: [17, 18] };
  assert.doesNotThrow(() => verifyCleanupCalldata(pending, { functionName: 'batch', args: [[17, 18], []] }));
  for (const decoded of [{ functionName: 'cancelAll', args: [] },
    { functionName: 'batch', args: [[17], []] }, { functionName: 'batch', args: [[17, 18], [{}]] },
    { functionName: 'batch', args: [[17, 19], []] }])
    assert.throws(() => verifyCleanupCalldata(pending, decoded), /CALLDATA_MISMATCH/);
  for (const ids of [[], [17, 17], [0], [-1], [2 ** 32], ['17'], Array.from({ length: MAKER_CLEANUP_MAX_BATCH + 1 }, (_, i) => i + 1)])
    assert.throws(() => cleanupIds(ids), /IDS_INVALID/);
});

test('canonical cleanup is recorded separately from quotes, including a raced already-filled cancel', () => {
  const pending = { action: 'cleanup', hash: '0xcleanup', side: 'sell', epoch: '2', cancelIds: [17, 18] };
  const events = [{ eventName: 'OrderCancelled', args: { id: 17, reason: 0, size: 2_000_000n } }];
  const input = { pending, events, orders: [emptyOrder, emptyOrder], trader: 2, owner: '0xowner', at: 2000 };
  const record = cleanupReceiptOutcome(input);
  assert.deepEqual(record.cancelIds, [17, 18]); assert.deepEqual(record.removedIds, [17]);
  assert.equal(record.orderId, undefined); assert.equal(record.tick, undefined);
  assert.deepEqual(cleanupReceiptOutcome({ ...input, events: [] }).removedIds, []);
  assert.throws(() => cleanupReceiptOutcome({ ...input, orders: [oldOrder, emptyOrder] }), /STILL_LIVE/);
  assert.throws(() => cleanupReceiptOutcome({ ...input, events: [...events, placed] }), /UNEXPECTED_PLACEMENT/);
  assert.throws(() => cleanupReceiptOutcome({ ...input, events: [{ eventName: 'OrderCancelled', args: { id: 99, reason: 0, size: 1n } }] }), /CANCEL_MISMATCH/);
});
