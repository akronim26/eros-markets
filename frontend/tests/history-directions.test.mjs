import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistory, historyTotals } from "../src/lib/history.ts";
import { historyDirections } from "../src/lib/history-direction.ts";

const engine = "0x1111111111111111111111111111111111111111", owner = "0x2222222222222222222222222222222222222222";
const event = (id, kind, payload, block, logIndex = 0) => ({
  id: `${kind}-${id}`, engine, kind, orderId: String(id), block, logIndex,
  timestamp: "1000", txHash: `0x${"12".repeat(32)}`, payload: JSON.stringify(payload),
});
const placement = (id, overrides = {}) => event(id, "OrderPlaced", { id: String(id), trader: "7", flags: 1, tick: 400, size: "1000", ...overrides }, 1, id);
const fill = (id) => event(id, "Fill", { makerOrder: String(id), maker: "7", taker: "8", tick: 400, size: "1000", makerFeeQ: "11", takerFeeQ: "13" }, 2, id);
const queryFor = (events, makerQuery) => async (query, variables) => {
  if (query.includes("_meta")) return { _meta: [{ progressBlock: 100, isReady: true }] };
  if (query.includes("$ids")) return makerQuery(query, variables);
  if (query.includes("$owner")) return { TradingEvent: events.slice(variables.offset, variables.offset + Math.min(17, variables.limit)) };
  return { TradingEvent: [] };
};
const read = (events, makerQuery) => readHistory(10143, engine, owner, 8, 100n, undefined, undefined, queryFor(events, makerQuery));

test("maker lookup is engine-scoped, ID-chunked and paginates past small server caps", async () => {
  const events = Array.from({ length: 101 }, (_, i) => fill(i + 1));
  const calls = [];
  const result = await read(events, async (query, v) => {
    calls.push(v);
    assert.match(query, /kind:\{_eq:"OrderPlaced"\}/);
    assert.match(query, /orderId:\{_in:\$ids\}/);
    assert.equal(v.engine, engine);
    assert.equal(v.chain, 10143);
    assert.equal(v.block, 100);
    assert.ok(v.ids.length <= 100);
    return { TradingEvent: v.ids.slice(v.offset, v.offset + 7).map(Number).map(id => placement(id)) };
  });
  assert.equal(result.complete, true);
  assert.equal(result.directionsComplete, true);
  assert.equal(result.events.length, 101);
  assert.equal(result.makerOrders.length, 101);
  assert.deepEqual(calls.filter(v => v.offset === 0).map(v => v.ids.length), [100, 1]);
  assert.deepEqual(calls.filter(v => v.ids.length === 1).map(v => v.offset), [0, 1]);
  assert.equal(historyDirections(result.events, 8, result.makerOrders).get("Fill-101"), "Sell YES");
  assert.equal(historyTotals(result.events, 8).feesQ, 101n * 13n);
});

test("already resolved maker fills require no supplemental lookup", async () => {
  let calls = 0;
  const result = await read([placement(1), fill(1)], async () => { calls++; return { TradingEvent: [] }; });
  assert.equal(calls, 0);
  assert.equal(result.directionsComplete, true);
});

test("missing flags, absent placements and failed lookup leave direction evidence incomplete", async () => {
  for (const rows of [[], [placement(1, { flags: undefined })]]) {
    const result = await read([fill(1)], async (_q, v) => ({ TradingEvent: v.offset ? [] : rows }));
    assert.equal(result.complete, true);
    assert.equal(result.directionsComplete, false);
    assert.equal(historyDirections(result.events, 8, result.makerOrders).has("Fill-1"), false);
  }
  const result = await read([fill(1)], async () => { throw new Error("Indexer unavailable"); });
  assert.equal(result.complete, true);
  assert.equal(result.directionsComplete, false);
  assert.deepEqual(result.makerOrders, []);
  assert.equal(historyTotals(result.events, 8).feesQ, 13n);
});

test("maker evidence rejects foreign engines, wrong IDs and conflicting event payloads", async () => {
  for (const row of [{ ...placement(1), engine: owner }, placement(2), { ...placement(1), orderId: "2" }]) {
    await assert.rejects(read([fill(1)], async () => ({ TradingEvent: [row] })), /unrelated maker-order evidence/);
  }
  // An invalid placement in loaded activity is not silently replaced by a different payload.
  await assert.rejects(read([placement(1, { flags: undefined }), fill(1)], async (_q, v) => ({ TradingEvent: v.offset ? [] : [placement(1)] })), /conflicting events/);
});

test("maker lookup stops at 20000 returned rows and marks capped evidence incomplete", async () => {
  let received = 0;
  const result = await read([fill(1)], async (_q, v) => {
    const length = Math.min(777, v.limit);
    received += length;
    return { TradingEvent: Array.from({ length }, () => placement(1)) };
  });
  assert.equal(received, 20000);
  assert.equal(result.directionsComplete, false);
  assert.equal(result.makerOrders.length, 1);
});
