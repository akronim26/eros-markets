import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexPacing, parseEarlyRequest, INDEX_CYCLE_SECS, TESTNET_INDEX_CARRY_SECS, KEEPER_INDEX_MAX_AGE_SECS, FRESH_UNTIL_SECS } from './index-pacing.mjs';

const engine = '0xAbC';
const at = sec => sec * 1000;
const cutoff = sec => BigInt(sec) - 18n;
function pacing({ status = null, early = null, ...rest } = {}) {
  const state = { status, early };
  const p = new IndexPacing({ engine, readKeeperStatus: () => state.status, readEarlyRequest: () => state.early, ...rest });
  return { p, state };
}
const decide = (p, sec) => p.minimumObservedAt(at(sec), cutoff(sec));

test('a 30 s fresh-source window, then a late fallback that still lands inside the 120 s carry', () => {
  assert.equal(INDEX_CYCLE_SECS, 70n);
  assert.equal(FRESH_UNTIL_SECS, 100n);
  assert.equal(TESTNET_INDEX_CARRY_SECS, 120n);
  assert.ok(FRESH_UNTIL_SECS <= TESTNET_INDEX_CARRY_SECS - 20n, 'the late fallback keeps 20 s before the carry ends');
  assert.equal(KEEPER_INDEX_MAX_AGE_SECS, 110n);
  assert.throws(() => new IndexPacing({ engine, cycleSecs: 100n }), /INVALID_INDEX_CYCLE/);
});

test('unknown chain history publishes at once (start, restart, wake)', () => {
  const { p } = pacing();
  assert.equal(decide(p, 1000), cutoff(1000));
});

test('after a finalized observation, publication holds for one cycle, then wants a fresh source', () => {
  const { p } = pacing();
  p.finalized(1000n);
  assert.equal(decide(p, 1001), 1001n, 'hold: no snapshot can be newer than now');
  assert.equal(decide(p, 1069), 1069n);
  assert.equal(decide(p, 1070), 1063n, 'due: only a source observed at 1064 or later (<= 6 s old)');
  assert.equal(decide(p, 1099), 1092n);
  assert.equal(decide(p, 1100), cutoff(1100), 'late: any source within the usual 18 s cutoff');
  p.finalized(1065n); // an older replayed result never moves the schedule back
  assert.equal(decide(p, 1050), 1050n);
});

test('the 2026-10-11 failure: a 15 s old source is no longer taken at the due time', () => {
  // Last observation 13:01:24; at 13:02:44 the old cadence published a source observed 13:02:29.
  const { p } = pacing();
  p.finalized(1000n);
  const due = 1080;
  assert.ok(1065n <= decide(p, due), 'the 15 s old source (observed 1065) is held');
  assert.ok(1074n > decide(p, due), 'a 6 s old source is taken');
});

test('warm-up publishes every source update until the keeper reports MARK', () => {
  const { p, state } = pacing({ status: { engine: '0xabc', state: 'running', at: at(1010), markAvailable: false } });
  p.finalized(1000n);
  assert.equal(decide(p, 1010), cutoff(1010));
  state.status = { ...state.status, markAvailable: true };
  assert.equal(decide(p, 1010), 1010n);
});

test('stale, stopped, foreign or unreadable keeper status keeps the slow cadence', () => {
  for (const status of [
    { engine, state: 'running', at: at(1000), markAvailable: false }, // 50 s old
    { engine, state: 'stopped', at: at(1050), markAvailable: false },
    { engine: '0xdef', state: 'running', at: at(1050), markAvailable: false },
    { engine, state: 'running', at: at(1050) }, // older keeper without the field
  ]) {
    const { p } = pacing({ status });
    p.finalized(1040n);
    assert.equal(decide(p, 1050), 1050n);
  }
  const p = new IndexPacing({ engine, readKeeperStatus: () => { throw Error('EIO'); } });
  p.finalized(1040n);
  assert.equal(decide(p, 1050), 1050n);
});

test('a book-change capture triggers one early observation strictly after the capture', () => {
  const { p, state } = pacing();
  p.finalized(1000n);
  state.early = { engine, capturedAt: '1030', at: at(1030) };
  assert.equal(decide(p, 1031), 1030n, 'snapshot must be newer than the capture');
  assert.equal(decide(p, 1060), cutoff(1060), 'a fresh cutoff after the capture is enough');
  p.finalized(1035n); // sealed
  assert.equal(decide(p, 1062), 1062n, 'no further early cycle for a sealed capture');
  assert.equal(decide(p, 1105), 1098n, 'the regular cycle restarts from the newest observation');
});

test('early observations are rate limited to one per 20 s', () => {
  const { p, state } = pacing();
  p.finalized(1000n);
  state.early = { engine, capturedAt: '1010', at: 0 };
  assert.equal(decide(p, 1011), 1010n);
  p.finalized(1012n);
  state.early = { engine, capturedAt: '1020', at: 0 };
  assert.equal(decide(p, 1021), 1021n, 'second capture 10 s later waits');
  assert.equal(decide(p, 1031), 1020n, 'released after 20 s');
});

test('invalid early requests are ignored', () => {
  assert.equal(parseEarlyRequest({ engine, capturedAt: 1030 }, engine), null);
  assert.equal(parseEarlyRequest({ engine: '0x1', capturedAt: '1030' }, engine), null);
  assert.equal(parseEarlyRequest(null, engine), null);
  assert.deepEqual(parseEarlyRequest({ engine: '0xABC', capturedAt: '7' }, engine), { capturedAt: 7n });
  const p = new IndexPacing({ engine, readEarlyRequest: () => { throw Error('EIO'); } });
  p.finalized(1000n);
  assert.equal(decide(p, 1010), 1010n);
});

test('one publish per cycle over an hour without trading', () => {
  const { p } = pacing();
  let publishes = 0, last = null;
  for (let sec = 0; sec < 3600; ++sec) {
    // Source updates every 20 s; it is fresh enough when newer than the minimum.
    const source = BigInt(sec - (sec % 20));
    if (source > decide(p, sec)) {
      ++publishes;
      if (last !== null) assert.ok(BigInt(sec) - last < TESTNET_INDEX_CARRY_SECS - 5n, 'lands inside the carry');
      last = BigInt(sec);
      p.finalized(source);
    }
  }
  assert.ok(publishes >= 3600 / 100 && publishes <= 3600 / 65, `publishes ${publishes}`);
});
