import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancePositionBasis, estimateTrade, reconstructPositionBasis } from '../src/lib/trade-estimate.ts';

const Q = 10n ** 18n;
const snapshot = (positionLots, cashQ) => ({ block: 7n, free: 23n,
  account: { preview: { positionLots, cashQ, projectedFundingQ: 3n * Q, projectedPremiumQ: 2n * Q,
    orders: { bidLots: 0n, askLots: 0n }, id: { markAvailable: true, markWad: 600n * 10n ** 15n } } } });
const estimate = (trader, patch = {}) => estimateTrade({ trader, block: 7n, isBuy: false, lots: 1000n, tick: 650, reduceOnly: true, feeCapQ: 5n * Q, ...patch });
const basis = (fills, expectedPositionLots, patch = {}) => reconstructPositionBasis({ fills, expectedPositionLots,
  complete: true, allPositionChangesKnown: true, throughBlock: 7n, snapshotBlock: 7n, ...patch });

test('full long exit estimates cash at the explicit limit including fees but not double accrual', () => {
  const result = estimate(snapshot(1000n, -480_000n * Q));
  assert.equal(result.available, true); assert.equal(result.effect.kind, 'closes');
  assert.equal(result.cashAfterQ, 169_995n * Q);
  assert.equal(result.potentialReleaseAtoms, 169_995n);
  assert.equal(result.vaultFreeAfterReleaseAtoms, 170_018n);
  assert.equal(result.projectedFundingQ, 3n * Q); assert.equal(result.projectedPremiumQ, 2n * Q);
  assert.equal(result.releaseGuaranteed, false); assert.equal(result.positionPnl.available, false);
});

test('partial short exit buys claims and never labels remaining cash as withdrawable', () => {
  const result = estimate(snapshot(-1000n, 700_000n * Q), { isBuy: true, lots: 400n, tick: 550 });
  assert.equal(result.effect.afterLots, -600n); assert.equal(result.cashAfterQ, 479_995n * Q);
  assert.equal(result.potentialReleaseAtoms, undefined); assert.equal(result.vaultFreeAfterReleaseAtoms, undefined);
  assert.equal(result.markEquityAfterQ, 119_995n * Q);
});

test('orders, absent mark, missing price/fees and mixed-block inputs do not invent availability', () => {
  const trader = snapshot(1000n, -480_000n * Q);
  trader.account.preview.orders.askLots = 1n;
  assert.equal(estimate(trader).potentialReleaseAtoms, undefined);
  trader.account.preview.id.markAvailable = false;
  assert.equal(estimate(trader, { lots: 500n }).markEquityAfterQ, undefined);
  for (const patch of [{ block: 8n }, { tick: 0 }, { feeCapQ: undefined }, { isBuy: true }]) assert.equal(estimate(trader, patch).available, false);
  assert.equal(estimate(undefined).available, false);
});

test('weighted entry replay retains exact fractions through partial closes and additions', () => {
  const p = basis([{ signedLots: 3n, tick: 601, feeQ: 7n }, { signedLots: -1n, tick: 620, feeQ: 1n },
    { signedLots: 1n, tick: 605, feeQ: 2n }], 3n);
  assert.equal(p.available, true);
  assert.deepEqual(p.entryValueQ, { numerator: 1807n * Q, denominator: 1n });
  assert.deepEqual(p.entryFeesQ, { numerator: 20n, denominator: 3n });
  const result = estimate(snapshot(3n, 0n), { lots: 1n, tick: 610, feeCapQ: 1n, basis: p });
  assert.equal(result.positionPnl.available, true);
  assert.equal(result.positionPnl.grossQ, 23n * Q / 3n);
  assert.equal(result.positionPnl.afterTradingFeesQ, (69n * Q - 29n) / 9n);
  assert.equal(result.positionPnl.excludesFundingAndPremium, true);
});

test('actual fill-derived long and short close P&L include allocated entry and exit fees', () => {
  const long = basis([{ signedLots: 1000n, tick: 600, feeQ: 3n * Q }], 1000n);
  const a = estimate(snapshot(1000n, -480_000n * Q), { basis: long });
  assert.equal(a.positionPnl.grossQ, 50_000n * Q); assert.equal(a.positionPnl.afterTradingFeesQ, 49_992n * Q);
  const short = basis([{ signedLots: -1000n, tick: 600, feeQ: 3n * Q }], -1000n);
  const b = estimate(snapshot(-1000n, 700_000n * Q), { isBuy: true, tick: 550, basis: short });
  assert.equal(b.positionPnl.grossQ, 50_000n * Q); assert.equal(b.positionPnl.afterTradingFeesQ, 49_992n * Q);
});

test('reversal resets remaining entry basis; incomplete or unreconciled history stays unavailable', () => {
  const fills = [{ signedLots: 3n, tick: 600, feeQ: 6n }, { signedLots: -5n, tick: 650, feeQ: 10n }];
  const p = basis(fills, -2n);
  assert.equal(p.available, true); assert.deepEqual(p.entryValueQ, { numerator: 1300n * Q, denominator: 1n });
  assert.deepEqual(p.entryFeesQ, { numerator: 4n, denominator: 1n });
  for (const patch of [{ complete: false }, { allPositionChangesKnown: false }, { throughBlock: 6n }]) assert.equal(basis(fills, -2n, patch).available, false);
  assert.equal(basis(fills, -1n).available, false);
  assert.equal(basis([{ signedLots: 1n, tick: 0, feeQ: 0n }], 1n).available, false);
});

test('an unchanged on-chain position version carries a verified basis across indexer lag', () => {
  const p = basis([{ signedLots: 1000n, tick: 600, feeQ: 0n }], 1000n);
  const historical = { block: 7n, positionLots: 1000n, positionVersion: 1n };
  const current = { ...historical, block: 20n };
  const updated = advancePositionBasis(p, historical, current, 1);
  assert.equal(updated.available, true); assert.equal(updated.block, 20n);
  assert.deepEqual(updated.entryValueQ, p.entryValueQ);
  assert.equal(advancePositionBasis(p, historical, { ...current, positionVersion: 3n }, 1).available, false,
    'a hidden close/reopen round trip has unchanged lots but a different version');
  assert.equal(advancePositionBasis(p, historical, { ...current, positionLots: 999n }, 1).available, false);
  assert.equal(advancePositionBasis(p, { ...historical, positionVersion: 2n }, { ...current, positionVersion: 2n }, 1).available, false,
    'equal versions cannot conceal history that omitted a position mutation');
  assert.equal(advancePositionBasis(p, historical, { ...current, block: 6n }, 1).available, false);
});
