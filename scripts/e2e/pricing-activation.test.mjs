import test from 'node:test';
import assert from 'node:assert/strict';
import { activationDecision, ActivationSchedule, readPricingActivation } from './pricing-activation.mjs';

const twap = (available, covered = 60n, wad = 5n * 10n ** 17n) => ({ available, twapWad: available ? wad : 0n, coveredSecs: covered });
const risk = (overrides = {}) => ({ pricingMode: 0, accountingState: 0, indexAvailable: true, ...overrides });

test('activation is due only in READY BOOTSTRAP with every window complete', () => {
  const all = { risk: risk(), index: twap(true), perp: twap(true), basis: twap(true) };
  assert.equal(activationDecision(all).due, true);
  assert.deepEqual(activationDecision({ ...all, risk: risk({ pricingMode: 1 }) }), { due: false, done: true, reason: 'normal-pricing' });
  assert.equal(activationDecision({ ...all, risk: risk({ accountingState: 1 }) }).reason, 'accounting-not-ready');
  assert.equal(activationDecision({ ...all, index: twap(false, 59n) }).reason, 'index-window');
  assert.equal(activationDecision({ ...all, risk: risk({ indexAvailable: false }) }).reason, 'index-window');
  const perp = activationDecision({ ...all, perp: twap(false, 44n) });
  assert.equal(perp.reason, 'perp-window');
  assert.equal(perp.perpSecs, 44n);
  assert.equal(activationDecision({ ...all, basis: twap(false, 58n) }).reason, 'basis-window');
  // A zero BASIS is a valid average; a zero PERP price is not.
  assert.equal(activationDecision({ ...all, basis: { available: true, twapWad: 0n, coveredSecs: 60n } }).due, true);
  assert.equal(activationDecision({ ...all, perp: { available: true, twapWad: 0n, coveredSecs: 60n } }).due, false);
});

test('readiness reads every window at the same block and timestamp', async () => {
  const calls = [];
  const client = { readContract: async request => {
    calls.push(request);
    return request.functionName === 'marketRiskView' ? risk() : twap(true);
  } };
  const decision = await readPricingActivation({ client, engine: '0xE', abi: [], block: { number: 7n, timestamp: 1000n } });
  assert.equal(decision.due, true);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.blockNumber, 7n);
  for (const call of calls.filter(c => c.functionName !== 'marketRiskView')) assert.deepEqual(call.args, [1000n]);
});

test('a finalized sample triggers an immediate recheck; otherwise rechecks are spaced', () => {
  let now = 1000;
  const schedule = new ActivationSchedule({ enabled: true, now: () => now });
  assert.equal(schedule.due(), true);
  schedule.waiting();
  assert.equal(schedule.due(), false);
  now += 1999;
  assert.equal(schedule.due(), false);
  schedule.sampled();
  assert.equal(schedule.due(), true);
  schedule.finished();
  assert.equal(schedule.due(), false);
  assert.equal(new ActivationSchedule({ enabled: false, now: () => now }).due(), false);
});
