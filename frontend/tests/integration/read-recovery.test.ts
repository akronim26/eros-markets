import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { client, ladderOptions } from "../../src/lib/reads";
import { markets } from "../../src/config/deployment";
import { resolveMarket } from "../../src/lib/market-discovery";
import { isContractRevert, isMissingContract } from "../../src/lib/read-errors";

const engine = "0x1111111111111111111111111111111111111111";

test("contract rejection and missing code remain distinct from transport failures", () => {
  const revert = new ContractFunctionRevertedError({ abi: [], functionName: "rollPage" });
  assert.equal(isContractRevert(new BaseError("wrapped", { cause: revert })), true);
  assert.equal(isMissingContract(new ContractFunctionZeroDataError({ functionName: "listing" })), true);
  assert.equal(isContractRevert(new BaseError("HTTP 429")), false);
  assert.equal(isMissingContract(new Error("Network offline")), false);
});

test("only manifest-backed terminals are exposed; unknown addresses never become unusable trading pages", async (t) => {
  const read = t.mock.method(client, "readContract", async () => { throw new Error("RPC unavailable"); });
  assert.equal(await resolveMarket(engine), undefined);
  assert.equal(await resolveMarket("not-an-address"), undefined);
  assert.equal(await resolveMarket(markets[0].engine), markets[0]);
  assert.equal(read.mock.callCount(), 0);
});

test("removing the final order clears cached depth without another contract call", async (t) => {
  t.mock.method(client, "getBlock", async () => ({ hash: "0x12" }));
  const read = t.mock.method(client, "multicall", async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ size: 100n })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const populated = ladderOptions(engine, 100n, 100, 900);
  const observer = new QueryObserver(qc, populated);
  const stop = observer.subscribe(() => {});
  try {
    const levels = await qc.fetchQuery(populated);
    assert.ok(levels.some((level) => level.tick === 100));
    assert.ok(levels.some((level) => level.tick === 900));
    const calls = read.mock.callCount();
    const empty = ladderOptions(engine, 101n, 0, 0);
    observer.setOptions(empty);
    assert.notDeepEqual(observer.getCurrentResult().data, levels, "old liquidity must disappear immediately");
    assert.deepEqual(await qc.fetchQuery(empty), []);
    assert.deepEqual(observer.getCurrentResult().data, []);
    assert.equal(read.mock.callCount(), calls);
  } finally { stop(); qc.clear(); }
});
