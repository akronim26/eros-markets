import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHeartbeat, recordHeartbeat, readActivity, ACTIVITY_TTL_SECONDS } from '../src/lib/market-activity.ts';
const A = '0x' + 'aB'.repeat(20), B = '0x' + 'cd'.repeat(20);
function memory() {
  const rows = new Map(), sets = [];
  return { rows, sets, get: async k => rows.get(k), set: async (k, v, o) => { sets.push(o); rows.set(k, v); } };
}
test('only exact listed engines are accepted', () => {
  assert.equal(parseHeartbeat({ engine: A.toUpperCase().replace('0X', '0x') }, [A]), A.toLowerCase());
  for (const body of [null, {}, { engine: 5 }, { engine: B }, { engine: A + '00' }]) assert.equal(parseHeartbeat(body, [A]), undefined);
});
test('heartbeats expire with the idle timeout and read back per engine', async () => {
  const cache = memory();
  await recordHeartbeat(cache, A.toLowerCase(), 1234);
  assert.equal(cache.sets[0].ttl, ACTIVITY_TTL_SECONDS);
  assert.deepEqual(await readActivity(cache, [A, B]), { engines: { [A.toLowerCase()]: 1234, [B]: null } });
  cache.rows.set(`market-activity:${B}`, 'bad');
  assert.equal((await readActivity(cache, [B])).engines[B], null);
});
