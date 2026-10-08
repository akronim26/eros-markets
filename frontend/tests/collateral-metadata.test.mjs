import assert from "node:assert/strict";
import { test } from "node:test";
import { createCollateralMetadataReader } from "../src/lib/collateral-metadata.ts";

const engine = `0x${"11".repeat(20)}`, archive = `0x${"22".repeat(20)}`;
const vault = `0x${"33".repeat(20)}`, archivedVault = `0x${"44".repeat(20)}`, token = `0x${"55".repeat(20)}`;
const success = result => ({ status: "success", result });
const failure = () => ({ status: "failure", error: new Error("RPC read failed") });
const expected = address => ({ vault: address === archive ? archivedVault : vault, token, decimals: 6, fallbackSymbol: "Collateral" });
const response = address => [success(expected(address).vault), success({ token }), success(token), success(6), success("TEST")];

function fixture({ verify = async () => {}, read = async request => response(request.contracts[0].address), scope = () => "10143:reviewed-current" } = {}) {
  const calls = [], verifications = [];
  const client = { multicall: async request => { calls.push(request); return read(request); } };
  const readAssets = createCollateralMetadataReader({ client, expected, cacheKey: scope,
    verify: async address => { verifications.push(address); await verify(address); } });
  return { readAssets, calls, verifications };
}

test("concurrent and later snapshots share one pinned immutable metadata batch", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ read: async request => { await pending; return response(request.contracts[0].address); } });
  const first = f.readAssets(engine, 100n), concurrent = f.readAssets(engine, 101n);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 1);
  finish();
  const [a, b] = await Promise.all([first, concurrent]);
  assert.equal(a, b);
  assert.equal(await f.readAssets(engine, 102n), a);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.verifications, [engine, engine, engine], "cache hits still require deployment trust");
  assert.equal(f.calls[0].blockNumber, 100n);
  assert.equal(f.calls[0].allowFailure, true, "optional symbol must not fail otherwise valid custody metadata");
  assert.deepEqual(f.calls[0].contracts.map(call => [call.address, call.functionName]), [
    [engine, "collateralVault"], [engine, "listing"], [vault, "token"], [token, "decimals"], [token, "symbol"],
  ]);
  assert.deepEqual(Object.keys(a).sort(), ["decimals", "symbol", "token", "vault"], "balances, allowances and risk are never cached here");
});

test("verification gates both misses and cache hits, and failures evict prior trust", async () => {
  let trust = false;
  let wait = Promise.resolve();
  const f = fixture({ verify: async () => { await wait; if (!trust) throw new Error("Deployment verification failed"); } });
  await assert.rejects(f.readAssets(engine, 100n), /verification failed/);
  assert.equal(f.calls.length, 0);
  trust = true;
  await f.readAssets(engine, 101n);
  let finish;
  wait = new Promise(resolve => { finish = resolve; });
  let returned = false;
  const cached = f.readAssets(engine, 102n).then(value => { returned = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, false, "a cached value must wait for current verification");
  trust = false;
  finish();
  await assert.rejects(cached, /verification failed/);
  trust = true;
  await f.readAssets(engine, 103n);
  assert.equal(f.calls.length, 2, "failed verification evicted the previously trusted metadata");
});

test("engine, reviewed manifest, chain and client scopes cannot share cached collateral", async () => {
  let network = "10143", identity = "reviewed-v1";
  const scope = () => `${network}:${identity}`;
  const f = fixture({ scope });
  assert.equal((await f.readAssets(engine, 100n)).vault, vault);
  assert.equal((await f.readAssets(archive, 101n)).vault, archivedVault, "archive sharing a token keeps its own vault");
  assert.equal(f.calls.length, 2);
  identity = "reviewed-v2";
  await f.readAssets(engine, 102n);
  network = "31337";
  await f.readAssets(engine, 103n);
  assert.equal(f.calls.length, 4);
  const otherClient = fixture({ scope });
  await otherClient.readAssets(engine, 103n);
  assert.equal(otherClient.calls.length, 1, "a new client cannot inherit another reader's verification or metadata");
});

test("transport and every required metadata failure are evicted and retried", async () => {
  for (const failedIndex of [-1, 0, 1, 2, 3]) {
    let fail = true;
    const f = fixture({ read: async () => {
      if (fail && failedIndex === -1) throw new Error("RPC transport failed");
      const value = response(engine);
      if (fail) value[failedIndex] = failure();
      return value;
    } });
    await assert.rejects(f.readAssets(engine, 100n), /RPC/);
    fail = false;
    assert.equal((await f.readAssets(engine, 101n)).symbol, "TEST");
    assert.equal(f.calls.length, 2);
  }
});

test("onchain engine vault, listing token, vault token and decimals must match the reviewed configuration", async () => {
  const incorrect = [archive, { token: archive }, archive, 18];
  for (let index = 0; index < incorrect.length; index++) {
    let mismatch = true;
    const f = fixture({ read: async () => {
      const value = response(engine);
      if (mismatch) value[index] = success(incorrect[index]);
      return value;
    } });
    await assert.rejects(f.readAssets(engine, 100n), /Unsupported collateral configuration/);
    mismatch = false;
    assert.equal((await f.readAssets(engine, 101n)).decimals, 6);
    assert.equal(f.calls.length, 2);
  }
});

test("failed or empty optional symbols use a temporary fallback and recover on retry", async () => {
  for (const optionalResult of [failure(), success("")]) {
    let missing = true;
    const f = fixture({ read: async () => {
      const value = response(engine);
      if (missing) value[4] = optionalResult;
      return value;
    } });
    const fallback = await f.readAssets(engine, 100n);
    assert.deepEqual(fallback, { vault, token, decimals: 6, symbol: "Collateral" });
    missing = false;
    assert.equal((await f.readAssets(engine, 101n)).symbol, "TEST");
    await f.readAssets(engine, 102n);
    assert.equal(f.calls.length, 2, "a successful label is cached after recovery");
  }
});
