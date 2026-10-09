import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makerReceiptOutcome } from './maker-receipt.mjs';
const pending = { hash: '0x1234', side: 'buy', epoch: '2', tick: 490, size: '2000000', functionName: 'batch' };
const order = { eventName: 'OrderPlaced', args: { trader: 1, id: 99, tick: 490, flags: 5, size: 2_000_000n } };
const input = { pending, events: [order], trader: 1, owner: 'owner', at: 10_000 };

test('exact maker placement saves the real order ID and executed size for restart maintenance', () => {
  const result = makerReceiptOutcome(input);
  assert.equal(result.kind, 'completed'); assert.equal(result.record.orderId, 99);
  assert.equal(result.record.size, '2000000'); assert.equal(result.record.epoch, '2');
});
test('wrong-side, wrong-price, excessive-size and duplicate placement receipts never complete a quote', () => {
  for (const args of [{ flags: 4 }, { tick: 491 }, { size: 2_000_001n }, { size: 0n }])
    assert.throws(() => makerReceiptOutcome({ ...input, events: [{ ...order, args: { ...order.args, ...args } }] }), /EVENT_MISMATCH/);
  assert.throws(() => makerReceiptOutcome({ ...input, events: [order, order] }), /EVENT_MISMATCH/);
});
test('a successful skipped replacement is recorded as no resting order, not retried under the old nonce', () => {
  assert.deepEqual(makerReceiptOutcome({ ...input, events: [] }), { kind: 'rejected', record: {
    hash: '0x1234', side: 'buy', epoch: '2', at: 10000, reason: 'post-only-skipped' } });
  assert.throws(() => makerReceiptOutcome({ ...input, pending: { ...pending, functionName: 'placeOrder' }, events: [] }), /EVENT_MISSING/);
  assert.equal(makerReceiptOutcome({ ...input, events: [{ eventName: 'OrderRejected', args: { trader: 1, reason: 7 } }] }).record.reason, 7);
});
