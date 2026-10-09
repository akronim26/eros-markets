import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makerPolicy, makerOrderIsCurrent, makerMaintenance, makerCaptureDelay, retryableMakerAdmission } from './maker-maintenance-policy.mjs';
const policy = makerPolicy({});
const input = { side: 'buy', positionLots: 0n, reservedLots: 2_000_000n, liveLots: 2_000_000n,
  tick: 490, liveTick: 490, depthLots: 1_000_000n, requiredDepthLots: 1_000_000n,
  actions: 1, lastActionAt: 0, now: 40_000, policy };

test('stable quotes survive polls, partial consumption replenishes, and repricing needs a meaningful move', () => {
  assert.equal(makerMaintenance(input).action, 'none');
  assert.equal(makerMaintenance({ ...input, tick: 494 }).action, 'none');
  assert.equal(makerMaintenance({ ...input, tick: 495 }).reason, 'reprice');
  assert.equal(makerMaintenance({ ...input, liveLots: 1_200_000n, reservedLots: 1_200_000n }).reason, 'replenish');
  assert.equal(makerMaintenance({ ...input, tick: 500, lastActionAt: 35_000 }).reason, 'requote-cooldown');
});

test('maintenance never duplicates unknown owner orders or exceeds funded-owner exposure and action budgets', () => {
  assert.equal(makerMaintenance({ ...input, reservedLots: 2_100_000n }).reason, 'untracked-owner-orders');
  assert.equal(makerMaintenance({ ...input, actions: 12 }).reason, 'epoch-action-budget');
  assert.equal(makerMaintenance({ ...input, positionLots: 3_500_000n }).reason, 'position-limit');
  assert.equal(makerMaintenance({ ...input, side: 'sell', positionLots: -3_500_000n }).reason, 'position-limit');
  assert.equal(makerMaintenance({ ...input, positionLots: 2_500_000n, liveLots: 0n, reservedLots: 0n }).size, 1_500_000n);
  assert.throws(() => makerPolicy({ EROS_MAKER_MAX_ACTIONS_PER_EPOCH: '0' }));
});

test('only a live order belonging to this owner, side and current epochs is replaceable', () => {
  const order = { owner: 1, size: 1n, flags: 5, marketEpoch: 2n, accountEpoch: 3n, expiryBlock: 0 };
  assert.equal(makerOrderIsCurrent(order, 1, 'buy', 2n, 3n, 100n), true);
  for (const changed of [{ owner: 2 }, { flags: 4 }, { marketEpoch: 1n }, { accountEpoch: 2n }, { size: 0n }, { expiryBlock: 99 }])
    assert.equal(makerOrderIsCurrent({ ...order, ...changed }, 1, 'buy', 2n, 3n, 100n), false);
});

test('optional maintenance waits for a newer accepted capture but repairs and bounded deferral cannot deadlock', () => {
  const wait = { repair: false, requestedAt: 100_000, initialPerpAt: 90n, latestPerpAt: 90n, now: 105_000, maxWaitMs: 15000 };
  assert.equal(makerCaptureDelay(wait), 10000);
  assert.equal(makerCaptureDelay({ ...wait, latestPerpAt: 100n }), 0);
  assert.equal(makerCaptureDelay({ ...wait, repair: true }), 0);
  assert.equal(makerCaptureDelay({ ...wait, now: 116_000 }), 0);
});

test('unsigned stale/index/post-only races retry without disguising owner or malformed-request errors', () => {
  for (const errorName of ['Stale', 'StaleEpochMutation', 'SnapshotMismatch', 'PostOnlyCrosses', 'OutsideBootstrapBand', 'Rejected', 'RestRejected'])
    assert.equal(retryableMakerAdmission({ cause: { data: { errorName } } }), errorName);
  for (const errorName of ['NotOwner', 'BadTick', 'BadSize', 'UnknownTrader', 'BadSignature', 'BadState'])
    assert.equal(retryableMakerAdmission({ cause: { data: { errorName } } }), null);
});
