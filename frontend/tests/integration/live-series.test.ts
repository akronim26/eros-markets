import assert from "node:assert/strict";
import { test } from "node:test";
import { readLiveSeries, emptySeries } from "../../src/lib/live-series";
import { client } from "../../src/lib/public-client";
const engine = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}`;

test("invalid-depth observations never render a fabricated zero index; overlapping polls deduplicate", async (t) => {
  t.mock.method(client, "getBlock", async ({blockNumber}: any) => ({hash, number:blockNumber, timestamp:1000n}));
  t.mock.method(client, "getLogs", async ({event}: any) => event.name === "ObservationAccepted" ? [
    {blockNumber:100n,args:{observedAt:990n,priceWad:500000000000000000n,depthValid:true}},
    {blockNumber:100n,args:{observedAt:991n,priceWad:0n,depthValid:false}},
  ] : []);
  const first = await readLiveSeries(engine, 100n, emptySeries());
  assert.equal(first.index.length,1); assert.equal(first.index[0].v,0.5);
  const second = await readLiveSeries(engine,101n,{...first,error:"old failure"});
  assert.equal(second.index.length,1); assert.equal(second.error,undefined);
});
test("reorganized chart reads are rejected, and a replaced cursor discards old history",async(t)=>{
  let reads=0;
  t.mock.method(client,"getLogs",async()=>[]);
  const blocks=t.mock.method(client,"getBlock",async()=>({hash:++reads===1?hash:`0x${"34".repeat(32)}`,timestamp:1000n}));
  await assert.rejects(readLiveSeries(engine,100n,emptySeries()),/reorganized/);
  blocks.mock.mockImplementation(async()=>({hash:`0x${"34".repeat(32)}`,timestamp:1000n}));
  const result=await readLiveSeries(engine,101n,{...emptySeries(),cursor:100n,cursorHash:hash as `0x${string}`,index:[{block:1n,t:1,v:0.2}]});
  assert.deepEqual(result.index,[]); assert.equal(result.since,2n);
});
