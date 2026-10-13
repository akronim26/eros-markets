import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { releasePreviewOptions, reserveOptions } from "../../src/lib/collateral-queries";
import { pinnedReadCurrent } from "../../src/lib/pinned-read";
import { client } from "../../src/lib/public-client";

const engine = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const reserve = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;

function blocks(t: TestContext) {
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }));
}

test("a slow release preview survives newer heads without mixing owner or amount", async (t) => {
  blocks(t);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const reads: any[] = [];
  t.mock.method(client, "readContract", async (args: any) => { reads.push(args); await gate; return [true, 0] as const; });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const first = qc.fetchQuery(releasePreviewOptions(engine, owner, 7, 100n, 100n));
    await new Promise(resolve => setTimeout(resolve, 5));
    const nextHead = qc.fetchQuery(releasePreviewOptions(engine, owner, 7, 100n, 101n));
    finish();
    const [a, b] = await Promise.all([first, nextHead]);
    assert.equal(a, b);
    assert.equal(reads.length, 1);
    assert.equal(a.block, 100n);
    assert.deepEqual(reads[0].args, [7, 100n]);
    assert.equal(pinnedReadCurrent(a, 101n), true);
    const refreshed = await qc.fetchQuery({ ...releasePreviewOptions(engine, owner, 7, 100n, 101n), staleTime: 0 });
    assert.equal(refreshed.block, 101n);
    assert.equal(reads[1].blockNumber, 101n);
    assert.notDeepEqual(releasePreviewOptions(engine, owner, 7, 100n, 101n).queryKey, releasePreviewOptions(engine, reserve, 7, 100n, 101n).queryKey);
    assert.notDeepEqual(releasePreviewOptions(engine, owner, 7, 100n, 101n).queryKey, releasePreviewOptions(engine, owner, 7, 101n, 101n).queryKey);
    assert.notDeepEqual(releasePreviewOptions(engine, owner, 7, 100n, 101n).queryKey, releasePreviewOptions(engine, owner, 8, 100n, 101n).queryKey);
  } finally { qc.clear(); }
});

test("reserve reads complete across advancing heads and keep every balance on the original canonical block", async (t) => {
  blocks(t);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const readBlocks: bigint[] = [];
  t.mock.method(client, "readContract", async ({ blockNumber, functionName }: any) => {
    readBlocks.push(blockNumber);
    if (functionName === "reserveVault") { await gate; return reserve; }
    return 5n;
  });
  t.mock.method(client, "multicall", async ({ blockNumber, contracts }: any) => {
    readBlocks.push(blockNumber);
    return contracts.length === 2 ? [1n, 20n] : [20n, 10n, 100n, 5n, 5n];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const first = qc.fetchQuery(reserveOptions(engine, owner, 100n));
    await new Promise(resolve => setTimeout(resolve, 5));
    const nextHead = qc.fetchQuery(reserveOptions(engine, owner, 101n));
    finish();
    const [a, b] = await Promise.all([first, nextHead]);
    assert.equal(a, b);
    assert.equal(a.block, 100n);
    assert.equal(a.value.user?.claimable, 5n);
    assert.ok(readBlocks.every(block => block === 100n));
    assert.equal(pinnedReadCurrent(a, 101n), true);
    assert.equal(pinnedReadCurrent(a, 99n), false);
    const refreshed = await qc.fetchQuery({ ...reserveOptions(engine, owner, 101n), staleTime: 0 });
    assert.equal(refreshed.block, 101n);
    assert.notDeepEqual(reserveOptions(engine, owner, 101n).queryKey, reserveOptions(engine, undefined, 101n).queryKey);
    assert.notDeepEqual(reserveOptions(engine, owner, 101n).queryKey, reserveOptions(engine, reserve, 101n).queryKey);
  } finally { qc.clear(); }
});

test("stale collateral previews and reorged reserve reads are rejected", async (t) => {
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash, timestamp: BigInt(Math.floor(Date.now() / 1000)) - 31n }));
  t.mock.method(client, "readContract", async () => [true, 0]);
  await assert.rejects(releasePreviewOptions(engine, owner, 7, 100n, 100n).queryFn(), /stale/i);
  let count = 0;
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash: ++count < 3 ? hash : `0x${"cd".repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) }));
  t.mock.method(client, "readContract", async () => reserve);
  t.mock.method(client, "multicall", async () => [1n, 20n]);
  await assert.rejects(reserveOptions(engine, undefined, 100n).queryFn(), /Read block changed/);
});
