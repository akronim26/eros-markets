import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MakerPairedMaintenance, makerPairContext } from './maker-paired-maintenance.mjs';
import { makerCaptureDelay, makerMaintenance, makerPolicy } from './maker-maintenance-policy.mjs';

const first = { hash: '0xfirst', side: 'buy', context: 'engine:epoch:profile:source', sequence: 10n,
  observedAt: 95n, eligible: true, paired: false, now: 100000 };
const second = { side: 'sell', context: first.context, sequence: 11n, observedAt: 96n, now: 107000 };
function finalized() {
  const pair = new MakerPairedMaintenance();pair.signed(first);
  pair.finalized({ hash: first.hash, side: first.side, accepted: true, receiptAt: 103000, now: 105000 });
  return pair;
}

test('a finalized first reprice removes the opposite owner second wait exactly once', () => {
  const pair = new MakerPairedMaintenance();pair.signed(first);
  assert.equal(pair.canUse(second), false, 'signed or pending is not canonical finality');
  pair.finalized({ hash: first.hash, side: 'buy', accepted: true, receiptAt: 103000, now: 105000 });
  assert.equal(makerCaptureDelay({ repair: false, requestedAt: 107000, initialPerpAt: 90n,
    latestPerpAt: 90n, maxWaitMs: 15000, now: 107000 }), 15000);
  assert.equal(pair.canUse(second), true);
  assert.equal(pair.consume(second), true);
  assert.equal(pair.consume(second), false);
  pair.signed({ ...first, ...second, hash: '0xsecond', paired: true });
  pair.finalized({ hash: '0xsecond', side: 'sell', accepted: true, receiptAt: 108000, now: 109000 });
  assert.equal(pair.canUse({ ...second, side: 'buy', now: 110000 }), false, 'pairs cannot chain');
});

test('receipt identity, rejected quotes, repairs and restart cannot create a hint', () => {
  for (const changed of [{ hash: '0xother' }, { side: 'sell' }, { accepted: false }, { receiptAt: 106000 }]) {
    const pair = new MakerPairedMaintenance();pair.signed(first);
    pair.finalized({ hash: first.hash, side: 'buy', accepted: true, receiptAt: 103000, now: 105000, ...changed });
    assert.equal(pair.canUse(second), false);
  }
  const repair = new MakerPairedMaintenance();repair.signed({ ...first, eligible: false });
  repair.finalized({ hash: first.hash, side: 'buy', accepted: true, receiptAt: 103000, now: 105000 });
  assert.equal(repair.canUse(second), false);
  const restarted = new MakerPairedMaintenance();
  restarted.finalized({ hash: first.hash, side: 'buy', accepted: true, receiptAt: 103000, now: 105000 });
  assert.equal(restarted.canUse(second), false);
});

test('owner, context, source monotonicity and both age bounds are rechecked before signing', () => {
  const pair = finalized();
  for (const changed of [{ side: 'buy' }, { context: 'next-epoch' }, { sequence: 9n }, { observedAt: 94n },
    { now: 102999 }, { now: 113000 }]) assert.equal(pair.consume({ ...second, ...changed }), false);
  assert.equal(pair.consume({ ...second, now: 112999 }), true);
  const slow = new MakerPairedMaintenance();slow.signed(first);
  slow.finalized({ hash: first.hash, side: 'buy', accepted: true, receiptAt: 114000, now: 114500 });
  assert.equal(slow.canUse({ ...second, now: 114999 }), true);
  assert.equal(slow.canUse({ ...second, now: 115000 }), false);
});

test('pair context binds deployment, epoch, risk profile/stage and configured source identity', () => {
  const input = { engine: '0xENGINE', epoch: 2n, risk: { riskVersion: 3n, profileHash: '0xPROFILE', pricingMode: 0, stage: 1 },
    sourceId: '0xSOURCE', source: { signer: '0xSIGNER', rulesHash: '0xRULES' } };
  const original = makerPairContext(input);
  for (const changed of [{ engine: '0xOTHER' }, { epoch: 3n }, { risk: { ...input.risk, riskVersion: 4n } },
    { risk: { ...input.risk, profileHash: '0xNEW' } }, { risk: { ...input.risk, stage: 2 } },
    { sourceId: '0xNEW' }, { source: { ...input.source, signer: '0xNEW' } }])
    assert.notEqual(makerPairContext({ ...input, ...changed }), original);
});

test('a pair never removes the other owner action, cooldown, exposure or unknown-order guards', () => {
  const pair = finalized();assert.equal(pair.canUse(second), true);
  const input = { side: 'sell', positionLots: 0n, reservedLots: 2000000n, liveLots: 2000000n,
    tick: 505, liveTick: 495, depthLots: 1000000n, requiredDepthLots: 1000000n,
    actions: 1, lastActionAt: 0, now: 107000, policy: makerPolicy({}) };
  assert.equal(makerMaintenance(input).reason, 'reprice');
  for (const changed of [{ actions: 12 }, { lastActionAt: 106000 }, { positionLots: -4000000n }, { reservedLots: 2000001n }])
    assert.equal(makerMaintenance({ ...input, ...changed }).action, 'wait');
});
