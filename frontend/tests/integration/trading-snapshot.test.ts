import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { client, tradingSnapshotOptions } from "../../src/lib/reads";

const engine = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const vault = "0x3333333333333333333333333333333333333333";
const token = "0x4444444444444444444444444444444444444444";
const hash = `0x${"ab".repeat(32)}`;

function reader(t: TestContext, delay: () => Promise<void> = async () => {}) {
  const blocks: bigint[] = [];
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash }));
  t.mock.method(client, "multicall", async ({ contracts, blockNumber }: any) => {
    blocks.push(blockNumber);
    switch (contracts[0].functionName) {
      case "active": return [true, false, true, { indexAvailable: true, markAvailable: true }, {}, {}, [400, 410], [400, 1n, 410, 1n], {}, 0n, 1n, [1n, 0n, 3600n, 0n, 0n, 0n, false], [0n, 0n, 0n], true, {}, [0n, 0n], 0n, [0n, 0n], [0n, 0n], 10, [0n, 0n, false], [5n, 5n]];
      case "collateralVault": await delay(); return [vault, { token }];
      case "token": return [token, 6];
      case "symbol": return [{ status: "success", result: "TEST" }];
      case "participantId": return [1, 10n, 20n, 30n];
      case "previewAccount": return [{ positionLots: 0n }, {}, 0n, false];
      default: throw new Error(`Unexpected call ${contracts[0].functionName}`);
    }
  });
  return blocks;
}

test("slow owner reads publish the same pinned block as market data and overlapping heads share one request", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocks = reader(t, () => gate);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    let published = false;
    const first = qc.fetchQuery(tradingSnapshotOptions(engine, owner, 100n)).then(data => { published = true; return data; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(published, false, "market must wait for its owner snapshot");
    const overlapping = qc.fetchQuery(tradingSnapshotOptions(engine, owner, 101n));
    release();
    const [a, b] = await Promise.all([first, overlapping]);
    assert.equal(a.market.block, 100n);
    assert.equal(a.trader?.block, 100n);
    assert.equal(a, b);
    assert.ok(blocks.every(block => block === 100n));
    const next = await qc.fetchQuery({ ...tradingSnapshotOptions(engine, owner, 101n), staleTime: 0 });
    assert.equal(next.market.block, 101n);
    assert.equal(next.trader?.block, 101n);
    assert.equal(next.market.leverageCaps.long, 5n);
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
  assert.notDeepEqual(tradingSnapshotOptions(engine, owner, 100n).queryKey, tradingSnapshotOptions(engine, vault, 100n).queryKey);
  const snapshot = await disconnected.queryFn();
  assert.equal(snapshot.accountError, false);
  assert.equal(snapshot.trader, undefined);
});
