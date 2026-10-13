import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { client } from "../../src/lib/public-client";
import { positionBasisHistoryOptions } from "../../src/lib/use-position-basis";

const engine = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
const hash = `0x${"ab".repeat(32)}`;

test("historical proof is shared and isolates engine, owner and history block", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: bigint[] = [];
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash }));
  t.mock.method(client, "readContract", async ({ blockNumber, functionName, args }: any) => {
    assert.equal(functionName, "account"); assert.deepEqual(args, [owner]);
    reads.push(blockNumber); await gate;
    return { value: { lots: 1000n }, positionVersion: 1n };
  });
  const options = positionBasisHistoryOptions(engine, owner, 90n);
  for (const scope of [positionBasisHistoryOptions(other, owner, 90n), positionBasisHistoryOptions(engine, other, 90n),
    positionBasisHistoryOptions(engine, owner, 91n)]) assert.notDeepEqual(options.queryKey, scope.queryKey);
  const qc = new QueryClient();
  try {
    const first = qc.fetchQuery(options), second = qc.fetchQuery(positionBasisHistoryOptions(engine, owner, 90n));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.deepEqual(reads, [90n]);
    assert.deepEqual(a, { block: 90n, blockHash: hash, positionLots: 1000n, positionVersion: 1n });
    assert.equal(await qc.fetchQuery(positionBasisHistoryOptions(engine, owner, 90n)), a);
  } finally { release(); qc.clear(); }
});

test("a reorg during historical verification fails instead of caching mixed-fork evidence", async t => {
  let calls = 0;
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber,
    hash: ++calls === 1 ? hash : `0x${"cd".repeat(32)}` }));
  t.mock.method(client, "readContract", async () => ({ value: { lots: 1000n }, positionVersion: 1n }));
  await assert.rejects(positionBasisHistoryOptions(engine, owner, 90n).queryFn(), /Read block changed/);
});

test("historical proof revalidation retains a changed canonical hash even with identical account values", async t => {
  let canonicalHash = hash, reads = 0;
  t.mock.method(client, "getBlock", async ({ blockNumber }: any) => ({ number: blockNumber, hash: canonicalHash }));
  t.mock.method(client, "readContract", async () => {
    reads++;
    return { value: { lots: 1000n }, positionVersion: 1n };
  });
  const qc = new QueryClient(), options = positionBasisHistoryOptions(engine, owner, 90n);
  try {
    const first = await qc.fetchQuery(options);
    canonicalHash = `0x${"cd".repeat(32)}`;
    await qc.invalidateQueries({ queryKey: options.queryKey });
    const next = await qc.fetchQuery(options);
    assert.equal(reads, 2);
    assert.notEqual(first, next, "canonical changes must invalidate memoized replay evidence");
    assert.equal(first.blockHash, hash);
    assert.equal(next.blockHash, canonicalHash);
  } finally { qc.clear(); }
});
