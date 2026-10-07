import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBootstrapRolloverDeferral } from './rollover-readiness.mjs';

function harness(overrides = {}) {
  const state = { now: 10_000n, scheduledT: 100_000n, epochEnd: 10_000n, epochId: 7n,
    active: true, work: 0, pricingMode: 0, stage: 0, accountingState: 1, pendingWork: 2,
    monitorRestricted: false, basisStart: 9_109n, lastAccepted: 9_990n,
    indexAvailable: true, perpAvailable: true, ...overrides };
  const reads = [];
  // A contiguous accepted history covers only through its last observation+30.
  // The wrapper cannot extend that endpoint after the old epoch expires.
  const window = (start, end, duration) => ({ available: end - duration >= start
    && end <= state.lastAccepted + 30n && (state.invalidAt === undefined || end <= state.invalidAt),
    twapWad: 500_000_000_000_000_000n });
  const input = { engine: '0x123', abi: [], scheduledT: state.scheduledT, pending: false,
    client: {
      getBlock: async () => ({ number: 123n, timestamp: state.now }),
      readContract: async request => {
        reads.push(request);
        assert.equal(request.blockNumber, 123n, 'every state and window read is pinned to one block');
        switch (request.functionName) {
          case 'marketRiskView': return state;
          case 'epoch': return [state.epochId, 6_400n, state.epochEnd];
          case 'active': return state.active;
          case 'work': return state.work;
          case 'indexTwap300': return { available: state.indexAvailable, twapWad: state.indexPrice ?? 500n };
          case 'perpTwap60': return { ...window(9_000n, request.args[0], 60n),
            ...(state.perpAvailable ? {} : { available: false }) };
          case 'basisTwap900': return window(state.basisStart, request.args[0], 900n);
          default: throw Error('unexpected function');
        }
      },
    } };
  return { state, input, reads, check: () => readBootstrapRolloverDeferral(input) };
}

test('short bootstrap carry completes BASIS nine seconds after epoch end and then releases rollover', async () => {
  const h = harness();
  for (const elapsed of [0n, 4n, 8n]) {
    h.state.now = h.state.epochEnd + elapsed;
    const result = await h.check();
    assert.equal(result.defer, true);
    assert.equal(result.deadline, 10_020n);
    assert.equal(result.basisReady, false);
    assert.equal(result.carryReady, true);
  }
  h.state.now = 10_009n;
  assert.equal((await h.check()).defer, false);
  assert.equal((await h.check()).reason, 'candidates-ready');
  assert.ok(h.reads.some(r => r.functionName === 'perpTwap60' && r.args[0] === 10_017n));
});

test('cannot wait minutes for BASIS: exhausted accepted carry releases bootstrap rollover', async () => {
  const h = harness({ basisStart: 9_400n });
  assert.equal((await h.check()).defer, true);
  h.state.now = 10_013n; // An inclusion eight seconds later would exceed carry at10020.
  assert.equal((await h.check()).defer, false);
  assert.equal((await h.check()).reason, 'carry-unavailable');
  h.state.now = 10_240n;
  assert.equal((await h.check()).defer, false);
});

test('bounded grace expires even if another publisher extends accepted history', async () => {
  const h = harness({ now: 10_020n, lastAccepted: 10_019n });
  assert.equal((await h.check()).defer, false);
  assert.equal(h.reads.length, 4, 'no window read after the absolute deadline');
});

test('signed pending journal bypasses all readiness RPCs', async () => {
  const h = harness();
  h.input.pending = true;
  h.input.client.getBlock = async () => { throw Error('RPC unavailable'); };
  assert.deepEqual(await h.check(), { defer: false, reason: 'pending' });
  assert.deepEqual(h.reads, []);
});

test('known future epoch skips deferral RPCs without changing the ordinary operations poll', async () => {
  const h = harness();
  h.input.knownEpochEnd = 10_000n;
  h.input.wallTimeMs = 9_999_999;
  const getBlock = h.input.client.getBlock;
  h.input.client.getBlock = async () => { throw Error('unexpected readiness RPC'); };
  assert.deepEqual(await h.check(), { defer: false, reason: 'epoch-not-due' });
  assert.deepEqual(h.reads, []);
  h.input.wallTimeMs = 10_000_000;
  h.input.client.getBlock = getBlock;
  assert.equal((await h.check()).defer, true, 'at the boundary, fresh pinned reads decide deferral');
});

test('NORMAL, underway sweeps, activation, monitor, floor and halt work never defer', async () => {
  for (const overrides of [
    { pricingMode: 1 }, { work: 1 }, { work: 2 }, { work: 3 }, { active: false },
    { accountingState: 0 }, { accountingState: 2 }, { accountingState: 3 },
    { epochId: 0n }, { now: 9_999n }, { monitorRestricted: true },
    { pendingWork: 3 }, { pendingWork: 6 }, { pendingWork: 10 },
    ...[1, 2, 3, 4, 5].map(stage => ({ stage })),
  ]) {
    const h = harness(overrides);
    assert.equal((await h.check()).defer, false, JSON.stringify(overrides, (_, value) => typeof value === 'bigint' ? String(value) : value));
    assert.equal(h.reads.length, 4);
  }
});

test('grace and inclusion reserve cannot reach the first time restriction or settlement', async () => {
  for (const scheduledT of [55_028n, 55_020n, 53_200n, 13_600n, 10_000n, 9_999n]) {
    const h = harness({ scheduledT });
    assert.equal((await h.check()).defer, false);
    assert.equal(h.reads.length, 4);
  }
  assert.equal((await harness({ scheduledT: 55_029n }).check()).defer, true);
});

test('unavailable or zero INDEX and unavailable PERP release rollover', async () => {
  for (const overrides of [{ indexAvailable: false }, { indexPrice: 0n }, { perpAvailable: false }]) {
    assert.equal((await harness(overrides).check()).defer, false);
  }
});

test('invalid checkpoint exactly at query time cannot masquerade as live PERP carry', async () => {
  const h = harness({ invalidAt: 10_000n });
  const result = await h.check();
  assert.equal(result.perpReady, true, 'integral ending at invalidation retains the valid preceding interval');
  assert.equal(result.carryReady, false);
  assert.equal(result.defer, false);
});

test('read failure propagates and never invents candidate readiness', async () => {
  const h = harness();
  const read = h.input.client.readContract;
  h.input.client.readContract = request => request.functionName === 'basisTwap900'
    ? Promise.reject(Error('RPC unavailable')) : read(request);
  await assert.rejects(h.check(), /RPC unavailable/);
});
