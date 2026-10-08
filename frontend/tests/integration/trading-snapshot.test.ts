import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { client, marketOptions, tradingSnapshotOptions } from "../../src/lib/reads";
import { publicManifest as manifest } from "../../src/config/deployment";

const engine = manifest.markets[0].engine;
const owner = "0x2222222222222222222222222222222222222222";
const otherOwner = "0x3333333333333333333333333333333333333333";
const vault = manifest.contracts.CollateralVault.address;
const token = manifest.contracts.CollateralToken.address;
const hash = `0x${"ab".repeat(32)}`;
const anchor = 99_999_999n;
let fixtureId = 0;

function reader(t: TestContext, delay: () => Promise<void> = async () => {}) {
  const blocks: bigint[] = [];
  const calls: { name: string; block: bigint; owner?: string }[] = [];
  // Real verification and metadata caches remain enabled, with independent test clients.
  const uid = client.uid;
  (client as { uid: string }).uid = `snapshot-fixture-${++fixtureId}`;
  t.after(() => { (client as { uid: string }).uid = uid; });
  const pins = new Map([...Object.values(manifest.contracts), ...manifest.markets.map(m => ({ address: m.engine, codehash: m.codehash }))]
    .map(pin => [pin.address.toLowerCase(), pin.codehash]));
  t.mock.method(client, "getChainId", async () => manifest.chainId);
  t.mock.method(client, "getBlock", async ({ blockNumber, blockTag }: any) => ({
    number: blockTag === "finalized" ? anchor : blockNumber,
    hash: blockNumber === BigInt(manifest.verifiedAt.blockNumber) ? manifest.verifiedAt.blockHash : hash,
  }));
  t.mock.method(client, "call", async ({ data, blockNumber }: any) => {
    assert.equal(blockNumber, anchor);
    const pin = pins.get(`0x${data.slice(4, 44)}`.toLowerCase());
    assert.ok(pin, "only the selected reviewed deployment is verified");
    return { data: pin };
  });
  t.mock.method(client, "multicall", async ({ contracts, blockNumber, deployless }: any) => {
    if (deployless) {
      assert.equal(blockNumber, anchor);
      return contracts.map(({ address, functionName, args }: any) => {
        const market = manifest.markets.find(m => m.engine.toLowerCase() === address.toLowerCase() || m.marketId === args?.[0]);
        if (functionName === "listing") return { marketId: market!.marketId, indexSourceId: market!.sourceId,
          token, registry: manifest.contracts.MarketRegistry.address, resolutionAuthority: manifest.contracts.ResolutionOracle.address };
        if (functionName === "listingHash") return market!.listingHash;
        if (functionName === "engineOf") return market!.engine;
        return ({ factory: manifest.contracts.MarketFactory.address, oracle: manifest.contracts.ResolutionOracle.address,
          registry: manifest.contracts.MarketRegistry.address, collateralVault: vault, token } as Record<string, string>)[functionName];
      });
    }
    blocks.push(blockNumber);
    calls.push({ name: contracts[0].functionName, block: blockNumber, owner: contracts[0].args?.[0] });
    switch (contracts[0].functionName) {
      case "active": return [true, false, true, { indexAvailable: true, markAvailable: true }, {}, {}, [400, 410], [400, 1n, 410, 1n], {}, 0n, 1n, [1n, 0n, 3600n, 0n, 0n, 0n, false], [0n, 0n, 0n], true, {}, [0n, 0n], 0n, [0n, 0n], [0n, 0n], 10, [0n, 0n, false], [5n, 5n]];
      case "collateralVault": return [vault, { token }, token, 6, "TEST"].map(result => ({ status: "success", result }));
      case "participantId": await delay(); return [1, blockNumber, blockNumber * 2n, blockNumber * 3n];
      case "previewAccount": return [{ positionLots: 0n, cashQ: blockNumber }, { cashQ: blockNumber * 4n }, blockNumber, false];
      default: throw new Error(`Unexpected call ${contracts[0].functionName}`);
    }
  });
  return { blocks, calls };
}

test("slow owner reads publish the same pinned block as market data and overlapping heads share one request", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { blocks, calls } = reader(t, () => gate);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = (block: bigint) => tradingSnapshotOptions(engine, owner, block, () => qc.fetchQuery(marketOptions(engine, block)));
  try {
    let published = false;
    const first = qc.fetchQuery(options(100n)).then(data => { published = true; return data; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(published, false, "the actionable snapshot must wait for its matching owner state");
    const overlapping = qc.fetchQuery(options(101n));
    release();
    const [a, b] = await Promise.all([first, overlapping]);
    assert.equal(a.market.block, 100n);
    assert.equal(a.trader?.block, 100n);
    assert.equal(a, b);
    assert.ok(blocks.every(block => block === 100n));
    await qc.invalidateQueries({ queryKey: marketOptions(engine, 101n).queryKey });
    const next = await qc.fetchQuery({ ...options(101n), staleTime: 0 });
    assert.equal(next.market.block, 101n);
    assert.equal(next.trader?.block, 101n);
    assert.equal(next.market.leverageCaps.long, 5n);
    assert.deepEqual([a.trader?.free, a.trader?.wallet, a.trader?.allowance, a.trader?.account?.riskView.cashQ], [100n, 200n, 300n, 400n]);
    assert.deepEqual([next.trader?.free, next.trader?.wallet, next.trader?.allowance, next.trader?.account?.riskView.cashQ], [101n, 202n, 303n, 404n]);
    assert.equal(a.trader?.assets, next.trader?.assets, "immutable collateral metadata is reused");
    assert.deepEqual(calls.filter(call => call.name === "collateralVault").map(call => call.block), [100n]);
    for (const name of ["participantId", "previewAccount"]) {
      assert.deepEqual(calls.filter(call => call.name === name).map(call => call.block), [100n, 101n], "balances, allowance and account risk remain fresh");
    }
  } finally { qc.clear(); }
});

test("failed owner reads keep current public prices but never publish stale owner balances", async (t) => {
  reader(t, async () => { throw new Error("RPC balance read failed"); });
  const snapshot = await tradingSnapshotOptions(engine, owner, 100n).queryFn();
  assert.equal(snapshot.market.risk.indexAvailable, true);
  assert.equal(snapshot.market.risk.markAvailable, true);
  assert.equal(snapshot.accountError, true);
  assert.equal(snapshot.trader, undefined);
});

test("disconnect and owner changes have distinct cache scopes", async (t) => {
  reader(t);
  const disconnected = tradingSnapshotOptions(engine, undefined, 100n);
  assert.notDeepEqual(disconnected.queryKey, tradingSnapshotOptions(engine, owner, 100n).queryKey);
  assert.notDeepEqual(tradingSnapshotOptions(engine, owner, 100n).queryKey, tradingSnapshotOptions(engine, otherOwner, 100n).queryKey);
  const snapshot = await disconnected.queryFn();
  assert.equal(snapshot.accountError, false);
  assert.equal(snapshot.trader, undefined);
});

test("shared public data completes while accounts are pending and wallet changes reuse that verified block", async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accountStarted = new Promise<void>(resolve => { started = resolve; });
  const { calls } = reader(t, () => { started(); return gate; });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = (address: typeof owner | typeof otherOwner | undefined, block: bigint) =>
    tradingSnapshotOptions(engine, address, block, () => qc.fetchQuery(marketOptions(engine, block)));
  try {
    let completed = false;
    const first = qc.fetchQuery(options(owner, 100n)).then(value => { completed = true; return value; });
    await accountStarted;
    const publicData = await qc.fetchQuery(marketOptions(engine, 101n));
    assert.equal(completed, false, "public data must not depend on the pending owner request");
    assert.equal(publicData.block, 100n, "a fresh shared public query retains its own pinned block");
    assert.equal(publicData.bestBid, 400);
    const second = qc.fetchQuery(options(otherOwner, 101n));
    const disconnected = await qc.fetchQuery(options(undefined, 101n));
    assert.equal(disconnected.market, publicData);
    assert.equal(disconnected.trader, undefined);
    assert.equal(calls.filter(call => call.name === "active").length, 1, "wallet changes do not duplicate public market reads");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.market, publicData);
    assert.equal(b.market, publicData);
    assert.equal(a.trader?.block, publicData.block);
    assert.equal(b.trader?.block, publicData.block);
    assert.deepEqual(calls.filter(call => call.name === "participantId").map(call => [call.owner, call.block]), [[owner, 100n], [otherOwner, 100n]]);
  } finally { release(); qc.clear(); }
});

test("a reorg between public and owner reads cannot combine snapshots from different forks", async t => {
  const { calls } = reader(t);
  const market = await marketOptions(engine, 100n).queryFn();
  assert.equal(market.blockHash, hash);
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash: `0x${"cd".repeat(32)}` }));
  await assert.rejects(tradingSnapshotOptions(engine, owner, 100n, async () => market).queryFn(), /Read block changed/);
  assert.equal(calls.filter(call => call.name === "participantId").length, 0, "mismatched market provenance blocks the account read");
});
