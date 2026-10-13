import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { client } from "../../src/lib/public-client";
import { orderPreviewCurrent, orderPreviewOptions } from "../../src/lib/order-preview";
import { pinnedReadCurrent, readPinned } from "../../src/lib/pinned-read";
import type { MarketSnapshot, TraderSnapshot } from "../../src/lib/reads";

const engine = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;
const identity = { stage: 0, pricingMode: 1, accountingState: 0, profileHash: hash, marketOrderEpoch: 1n, indexAvailable: true, markAvailable: true };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const options = (block: bigint) => orderPreviewOptions(engine, owner, 1, "buy", 510, 100n, false, block);

test("slow order previews survive advancing heads without spawning replacement reads", async (t) => {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: bigint[] = [];
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, timestamp, hash }));
  t.mock.method(client, "readContract", async ({ blockNumber }: any) => {
    reads.push(blockNumber); await gate;
    return { id: identity, rejection: 0, acceptedCapLots: 100n };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(qc, options(100n));
  const stop = observer.subscribe(() => {});
  try {
    await tick();
    observer.setOptions(options(101n));
    observer.setOptions(options(102n));
    assert.equal(observer.getCurrentResult().data, undefined);
    assert.deepEqual(reads, [100n], "head updates must share the in-flight request");
    release(); await tick();
    const result = observer.getCurrentResult().data!;
    assert.equal(result.block, 100n, "the completed canonical preview reaches the active observer");
    assert.equal(result.value.acceptedCapLots, 100n);
    const currentMarket = { block: 102n } as MarketSnapshot;
    const currentTrader = { block: 102n, account: { preview: { id: identity } } } as TraderSnapshot;
    assert.equal(orderPreviewCurrent(result, currentMarket, currentTrader), true);
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data?.block, 102n, "next poll uses the latest captured head");
    assert.deepEqual(reads, [100n, 102n]);
  } finally { release(); stop(); qc.clear(); }
});

test("owner, trader and exact order inputs never share a preview cache", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = options(100n);
  qc.setQueryData(first.queryKey, { value: { id: identity, acceptedCapLots: 100n }, block: 100n, timestamp: 1n });
  const changed = [
    orderPreviewOptions(engine, other, 1, "buy", 510, 100n, false, 100n),
    orderPreviewOptions(engine, owner, 2, "buy", 510, 100n, false, 100n),
    orderPreviewOptions(engine, owner, 1, "sell", 510, 100n, false, 100n),
    orderPreviewOptions(engine, owner, 1, "buy", 511, 100n, false, 100n),
    orderPreviewOptions(engine, owner, 1, "buy", 510, 101n, false, 100n),
    orderPreviewOptions(engine, owner, 1, "buy", 510, 100n, true, 100n),
  ];
  try {
    for (const option of changed) {
      const observer = new QueryObserver(qc, { ...option, enabled: false });
      assert.equal(observer.getCurrentResult().data, undefined);
      observer.destroy();
    }
  } finally { qc.clear(); }
});

test("preview provenance expires and invalidates across account or market-state transitions", () => {
  const data = { value: { id: identity }, block: 100n, timestamp: 1000n } as any;
  const market = { block: 101n } as MarketSnapshot;
  const trader = { block: 101n, account: { preview: { id: identity } } } as TraderSnapshot;
  assert.equal(orderPreviewCurrent(data, market, trader, 1_029_000), true);
  assert.equal(orderPreviewCurrent(data, market, trader, 1_031_000), false);
  assert.equal(orderPreviewCurrent(data, market, trader, 994_000), false);
  assert.equal(pinnedReadCurrent(data, 99n, 1_000_000), false);
  assert.equal(orderPreviewCurrent(data, market, { ...trader, block: 100n }, 1_000_000), false);
  for (const changed of [{ stage: 1 }, { pricingMode: 0 }, { accountingState: 1 }, { profileHash: "0x1234" }, { marketOrderEpoch: 2n }, { markAvailable: false }, { indexAvailable: false }]) {
    const next = { ...trader, account: { preview: { id: { ...identity, ...changed } } } } as TraderSnapshot;
    assert.equal(orderPreviewCurrent(data, market, next, 1_000_000), false);
  }
});

test("canonical preview reads reject reorganized, stale and future blocks", async (t) => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  let timestamp = now;
  let reorg = false;
  let calls = 0;
  t.mock.method(client, "getBlock", async () => ({ timestamp, hash: reorg && ++calls === 3 ? `0x${"cd".repeat(32)}` : hash }));
  assert.equal((await readPinned(100n, async () => "ok")).value, "ok");
  timestamp = now - 31n;
  await assert.rejects(readPinned(100n, async () => "stale"), /stale or has an invalid timestamp/);
  timestamp = now + 7n;
  await assert.rejects(readPinned(100n, async () => "future"), /stale or has an invalid timestamp/);
  timestamp = now; reorg = true; calls = 0;
  await assert.rejects(readPinned(100n, async () => "reorg"), /Read block changed/);
});
