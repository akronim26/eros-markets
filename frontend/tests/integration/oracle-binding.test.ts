import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { resolveOracleBinding } from "../../src/lib/oracle-binding";
import { readOracleSnapshot } from "../../src/lib/oracle-reads";
import { client } from "../../src/lib/public-client";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const id = `0x${"a".repeat(64)}` as Hex;
const manifests = [
  { contracts: { MarketRegistry: { address: address("1") }, ResolutionOracle: { address: address("2") } }, markets: [{ marketId: id, engine: address("3") }] },
  { contracts: { MarketRegistry: { address: address("4") }, ResolutionOracle: { address: address("5") } }, markets: [{ marketId: id, engine: address("6") }] },
];

test("an archived engine selects its original oracle despite a repeated market ID on a new deployment", () => {
  const current = resolveOracleBinding(id, address("3"), manifests);
  const archived = resolveOracleBinding(id, address("6"), manifests);
  assert.equal(current.resolutionOracle, address("2"));
  assert.equal(archived.resolutionOracle, address("5"));
  assert.equal(archived.marketRegistry, address("4"));
  assert.throws(() => resolveOracleBinding(id, undefined, manifests), /Select the engine/);
  assert.throws(() => resolveOracleBinding(id, address("7"), manifests), /verified engine/);
  assert.throws(() => resolveOracleBinding(`0x${"b".repeat(64)}`, address("6"), manifests), /verified engine/);
  assert.equal(resolveOracleBinding(`0x${"b".repeat(64)}`, undefined, manifests).resolutionOracle, address("2"));
});

test("archived oracle snapshots pin every read to the selected registry and carry that binding into actions", async t => {
  const oracle = resolveOracleBinding(id, address("6"), manifests);
  t.mock.method(client, "getBlock", async () => ({ hash: id }));
  const read = t.mock.method(client, "multicall", async ({ contracts, blockNumber }: any) => {
    assert.equal(blockNumber, 100n);
    for (const call of contracts) {
      assert.equal(call.address, ["getQuestion", "getRules", "getMarketCore"].includes(call.functionName) ? address("4") : address("5"));
      assert.deepEqual(call.args, [id]);
    }
    return ["Archived question", "Rules", { engine: address("6") }, { state: 0 }, "", 1n, 10n, "0x"];
  });
  const snapshot = await readOracleSnapshot(id, oracle, 100n, 1000n);
  assert.equal(snapshot.oracle, oracle);
  assert.equal(snapshot.core.engine, address("6"));
  assert.equal(snapshot.block, 100n);
  assert.equal(read.mock.callCount(), 1);
});

test("a registry response for a different engine fails closed", async t => {
  t.mock.method(client, "getBlock", async () => ({ hash: id }));
  t.mock.method(client, "multicall", async () => ["Question", "Rules", { engine: address("3") }, {}, "", 1n, 10n, "0x"]);
  await assert.rejects(readOracleSnapshot(id, resolveOracleBinding(id, address("6"), manifests), 100n, 1000n), /verified engine/);
});
