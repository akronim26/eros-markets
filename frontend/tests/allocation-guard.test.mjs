import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { allocationBlocker, validateAllocation } from "../src/lib/allocation-guard.ts";
import { amountWithinBalance, atomsToInput, canClaim, fundingPlan } from "../src/lib/funds.ts";
import { atomsToUsdc, parseUsdcToAtoms } from "../src/lib/units.ts";
import { client } from "../src/lib/public-client.ts";

const engine = `0x${"1".repeat(40)}`, owner = `0x${"2".repeat(40)}`;
const ready = { active: true, halted: false, work: 0, risk: { accountingState: 0, stage: 0, pendingWork: 0, indexAvailable: false, markAvailable: false } };

test("funding blocks an expired accounting epoch, sweeps, pending floor work and halt", () => {
  for (const accountingState of [1, 2, 3]) {
    assert.equal(allocationBlocker({ ...ready, risk: { ...ready.risk, accountingState } }), "Market maintenance pending");
  }
  assert.equal(allocationBlocker({ ...ready, risk: { ...ready.risk, stage: 2, pendingWork: 1 } }), "Market maintenance pending");
  assert.equal(allocationBlocker({ ...ready, halted: true }), "Market halted");
  assert.equal(allocationBlocker({ ...ready, risk: { ...ready.risk, stage: 4 } }), "Market halted");
});

test("preactivation funding, READY recovery, reduce-only topups and absent prices remain allowed", () => {
  const inactive = { ...ready, active: false, risk: { ...ready.risk, accountingState: 1, pendingWork: 2 } };
  assert.equal(allocationBlocker(inactive), undefined, "derived rollover before activation is not pending work");
  assert.equal(allocationBlocker({ ...inactive, work: 2 }), "Market maintenance pending", "raw accounting work still gates allocation");
  assert.equal(allocationBlocker(ready), undefined, "index, mark and priceReady are not funding requirements");
  assert.equal(allocationBlocker({ ...ready, risk: { ...ready.risk, stage: 3 } }), undefined);
  assert.equal(allocationBlocker({ ...ready, risk: { ...ready.risk, pendingWork: 8 } }), undefined, "a staged future profile does not block current funding");
});

test("latest allocation validation pins every read to the requested simulation block and fails closed", async t => {
  const seen = [];
  t.mock.method(client, "multicall", async request => {
    seen.push(request);
    return [true, false, { ...ready.risk, accountingState: request.blockNumber === 101n ? 1 : 0 }, 0];
  });
  await validateAllocation(engine, 100n);
  await assert.rejects(validateAllocation(engine, 101n), /Market maintenance pending/);
  await validateAllocation(engine, 102n);
  assert.deepEqual(seen.map(request => request.blockNumber), [100n, 101n, 102n]);
  for (const request of seen) {
    assert.equal(request.allowFailure, false);
    assert.deepEqual(request.contracts.map(call => call.functionName), ["active", "halted", "marketRiskView", "work"]);
    assert.ok(request.contracts.every(call => call.address === engine));
  }
  await assert.rejects(validateAllocation(engine, 103n, async () => { throw new Error("Read failed"); }), /Read failed/);
});

// Invoke the production component with providers replaced, preserving its guard and call construction.
function actions({ mode = "Fund", market = ready, read = async () => ready, free = 0n, wallet = 2_000_000n, allowance = 0n } = {}) {
  const source = readFileSync(new URL("../src/components/account-actions.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const state = [mode, "1", true], calls = [];
  let stateIndex = 0;
  const jsx = (type, props) => ({ type, props });
  const deps = {
    react: { useState: () => [state[stateIndex++], () => {}], useEffect() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tanstack/react-query": { useQuery: () => ({}) },
    "@/lib/trader": { ownerTrader: () => Object.fromEntries(["approve", "deposit", "allocate", "withdraw", "release"].map(functionName => [functionName, amount => ({ address: engine, functionName, args: [amount] })])) },
    "@/config/deployment": { deployment: { risk: { collateralSymbol: "USDC" } }, marketByEngine: () => ({ archived: false }) },
    "@/lib/funds": { amountWithinBalance, atomsToInput, canClaim, fundingPlan },
    "@/lib/allocation-guard": { allocationBlocker, validateAllocation: (address, block) => validateAllocation(address, block, read) },
    "@/lib/units": { atomsToUsdc, parseUsdcToAtoms },
    "@/lib/enums": { REJECT: {} },
    "@/lib/collateral-queries": { releasePreviewOptions: () => ({}) },
    "@/lib/pinned-read": { pinnedReadCurrent: () => false },
    "@/lib/tx": { useTx: () => ({ state: { status: "idle" }, run: async (_owner, value) => { calls.push(...value); } }) },
    "./wallet": { useOwner: () => ({ address: owner, wrongChain: false }) },
    "./ui": { Button: "button", cx: (...values) => values.filter(Boolean).join(" ") },
    "./feedback": { useFieldErrors: () => ({ props: () => ({}), errorId: () => "amount-error", message: () => "" }) },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(key => deps[key] ?? {}, module, module.exports);
  const tree = module.exports.AccountActions({ engine, m: { block: 100n, ...market },
    t: { block: 100n, traderId: 1, free, wallet, allowance, assets: { symbol: "USDC" }, account: { preview: { cashQ: 1n, positionLots: 0n, usableReleaseAtoms: 1_000_000n }, claimable: 0n } } });
  const nodes = value => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
  const submit = nodes(tree).find(node => node.type === "button" && node.props.variant === "primary");
  assert.ok(submit);
  return { submit: submit.props, calls };
}

test("actual Fund control disables for maintenance then recovers, while Withdraw remains available", async () => {
  const maintenance = { ...ready, risk: { ...ready.risk, accountingState: 1 } };
  const blocked = actions({ market: maintenance });
  assert.equal(blocked.submit.disabled, true);
  assert.equal(blocked.submit.children, "Market maintenance pending");
  await blocked.submit.onClick();
  assert.equal(blocked.calls.length, 0);
  for (const market of [ready, { ...ready, active: false, risk: { ...ready.risk, accountingState: 1 } }]) {
    const allowed = actions({ market });
    assert.equal(allowed.submit.disabled, false);
    assert.equal(allowed.submit.children, "Fund collateral");
  }
  for (const market of [maintenance, { ...ready, halted: true }]) {
    const withdraw = actions({ mode: "Withdraw", market, free: 1_000_000n });
    assert.equal(withdraw.submit.disabled, false);
    await withdraw.submit.onClick();
    assert.equal(withdraw.calls[0].functionName, "withdraw");
    assert.equal(withdraw.calls[0].validate, undefined, "vault withdrawal does not inherit allocation readiness");
  }
});

test("every funding step rechecks readiness instead of trusting the UI snapshot", async () => {
  let current = ready;
  const blocks = [];
  const result = actions({ read: async (address, block) => { assert.equal(address, engine); blocks.push(block); return current; } });
  await result.submit.onClick();
  assert.deepEqual(result.calls.map(call => call.functionName), ["approve", "deposit", "allocate"]);
  for (const [index, call] of result.calls.entries()) {
    assert.equal(typeof call.validate, "function");
    current = { ...ready, risk: { ...ready.risk, accountingState: 1 } };
    await assert.rejects(call.validate(200n + BigInt(index)), /Market maintenance pending/);
    current = ready;
    await call.validate(300n + BigInt(index));
  }
  assert.deepEqual(blocks, [200n, 300n, 201n, 301n, 202n, 302n]);
  const onlyAllocate = actions({ free: 1_000_000n, wallet: 0n });
  await onlyAllocate.submit.onClick();
  assert.deepEqual(onlyAllocate.calls.map(call => call.functionName), ["allocate"]);
  assert.equal(typeof onlyAllocate.calls[0].validate, "function");
});
