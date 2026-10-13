import assert from "node:assert/strict";
import { test } from "node:test";
import { positionLabel, orderSideLabel } from "../src/lib/position-label.ts";
import { historyDirections, historyPositionFills } from "../src/lib/history-direction.ts";

const engine = "0x1111111111111111111111111111111111111111";
const event = (id, kind, payload, block = 2, logIndex = 0) => ({
  id, engine, kind, block, logIndex, timestamp: "1000", txHash: `0x${"12".repeat(32)}`,
  payload: JSON.stringify(payload),
});
const placed = (flags = 1, overrides = {}) => event("placed", "OrderPlaced", { id: 9, trader: 7, tick: 400, size: "10000", flags, ...overrides }, 1);
const fill = (overrides = {}) => event("fill", "Fill", { makerOrder: 9, maker: 7, taker: 8, tick: 400, size: "1000", makerFeeQ: "11", takerFeeQ: "13", ...overrides });

test("net positions show the signed YES exposure with an absolute claim quantity", () => {
  assert.equal(positionLabel(10001n), "Long YES · 10.001 claims");
  assert.equal(positionLabel(-10001n), "Short YES · 10.001 claims");
  assert.equal(positionLabel(0n), "Flat · 0.000 claims");
  assert.equal(positionLabel(-9007199254740993001n), "Short YES · 9007199254740993.001 claims");
  assert.equal(orderSideLabel(true), "Buy YES");
  assert.equal(orderSideLabel(false), "Sell YES");
});

test("history uses maker flags and reverses the action for the taker, including reduce-only orders", () => {
  for (const flags of [0, 1, 2, 3]) {
    const events = [fill(), placed(flags)];
    assert.equal(historyDirections(events, 7).get("fill"), flags & 1 ? "Buy YES" : "Sell YES");
    assert.equal(historyDirections(events, 8).get("fill"), flags & 1 ? "Sell YES" : "Buy YES");
    assert.equal(historyDirections(events, 7).get("placed"), flags & 1 ? "Buy YES" : "Sell YES");
    assert.equal(historyDirections(events, 8).has("placed"), false);
    assert.equal(historyDirections(events, 99).size, 0);
  }
});

test("supplemental maker placements resolve taker fills without adding account activity", () => {
  const activity = [fill()];
  assert.equal(historyDirections(activity, 8).get("fill"), undefined);
  assert.equal(historyDirections(activity, 8, [placed()]).get("fill"), "Sell YES");
  assert.equal(activity.length, 1);
  const cancelled = event("cancel", "OrderCancelled", { id: 9, size: "9000" }, 3);
  assert.equal(historyDirections([placed(), cancelled], 7).get("cancel"), "Buy YES");
});

test("history does not infer direction from missing, unrelated, future or malformed maker evidence", () => {
  const wrongEngine = { ...placed(), engine: "0x2222222222222222222222222222222222222222" };
  const future = { ...placed(), block: 3 };
  const laterLog = { ...placed(), block: 2, logIndex: 1 };
  for (const evidence of [wrongEngine, future, laterLog, placed(1, { trader: 99 }), placed(1, { tick: 500 }), placed(undefined, { flags: undefined }), placed(256)]) {
    assert.equal(historyDirections([fill()], 8, [evidence]).has("fill"), false);
  }
  assert.equal(historyDirections([placed(), fill({ maker: 7, taker: 7 })], 7).has("fill"), false);
  assert.equal(historyDirections([placed(), fill({ makerOrder: undefined })], 8).has("fill"), false);
  assert.equal(historyDirections([placed(), fill()], undefined).size, 0);
  assert.equal(historyDirections([placed(), fill()], 0).size, 0);
});

test("entry-basis fills use exact signed lots and only the account's fee, never mirrored postings", () => {
  const activity = [fill(), fill(), event("mirror", "PairedPosting", { feesQ: "24" })];
  assert.deepEqual(historyPositionFills(activity, 7, [placed()]), {
    fills: [{ signedLots: 1000n, tick: 400, feeQ: 11n }], allPositionChangesKnown: true,
  });
  assert.deepEqual(historyPositionFills(activity, 8, [placed()]), {
    fills: [{ signedLots: -1000n, tick: 400, feeQ: 13n }], allPositionChangesKnown: true,
  });
});

test("basis inference stays unavailable after unresolved fills, pair reductions or takeovers", () => {
  assert.equal(historyPositionFills([fill()], 8).allPositionChangesKnown, false);
  for (const kind of ["PairReduction", "AccountTakenOver"]) {
    assert.equal(historyPositionFills([fill(), event("mutation", kind, {})], 8, [placed()]).allPositionChangesKnown, false);
  }
  assert.equal(historyPositionFills([fill({ size: "0" })], 8, [placed()]).allPositionChangesKnown, false);
  assert.equal(historyPositionFills([fill({ takerFeeQ: "-1" })], 8, [placed()]).allPositionChangesKnown, false);
});
