import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const engine = `0x${"1".repeat(40)}`, owner = `0x${"2".repeat(40)}`;
const source = readFileSync(new URL("../src/components/operations-panel.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const nodes = value => !value || typeof value !== "object" ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];

/** Exercise the production component's eligibility and simulation handling with an RPC double. */
function harness() {
  const state = { active: true, halted: false, work: 0, cursor: 0, count: 65, now: 1_001n, end: 1_000n };
  const calls = [], writes = [];
  let options, queryResult, queryIndex, rpcFailure;
  const reject = () => { throw Object.assign(new Error("BadState"), { contractRevert: true }); };
  const simulate = async request => {
    calls.push(request);
    if (rpcFailure) throw rpcFailure;
    const { functionName, args } = request;
    if (functionName === "beginRollover") {
      if (!state.active || state.halted || state.work !== 0 || state.now < state.end) reject();
    } else if (functionName === "rollPage") {
      if (state.work !== 1) reject();
      return { result: state.cursor + args[0] >= state.count };
    } else if (functionName === "finishRollover") {
      if (state.work !== 1 || state.cursor !== state.count) reject();
    } else reject();
    return { result: undefined };
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@tanstack/react-query": { useQuery: value => {
      if (queryIndex++ !== 0) return {};
      options = value;
      return queryResult ?? {};
    } },
    "@/abi/engine": { engineAbi: [] },
    "@/lib/reads": { client: { simulateContract: simulate, readContract: async () => 0n } },
    "@/lib/pinned-read": {
      readPinned: async (block, read) => ({ block, value: await read() }),
      pinnedReadCurrent: (data, block) => data?.block === block,
    },
    "@/lib/tx": { useTx: () => ({ state: { status: "idle" }, run: async (address, actions) => {
      assert.equal(address, owner); writes.push(...actions);
    } }) },
    "@/lib/units": { qToMoney: () => ({ usdc: "0.00" }), lotsToClaims: String },
    "./wallet": { useOwner: () => ({ address: owner, wrongChain: false }) },
    "./ui": { Button: "button", Row: "row" },
    "./tx-feedback": { TxFeedback: "feedback" },
    "@/lib/read-errors": { isContractRevert: error => error.contractRevert === true },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(key => deps[key], module, module.exports);
  function render() {
    queryIndex = 0;
    return module.exports.OperationsPanel({ engine, m: {
      block: 100n, active: state.active, halted: state.halted, participants: BigInt(state.count),
      epoch: { id: 1n, end: state.end }, listing: { deploymentCapX: 1n, scheduledT: 10_000n },
      risk: { accountingState: state.active && state.now >= state.end ? 1 : state.work,
        asOfTime: state.now, pendingWork: 0, indexAvailable: false },
      settlement: { snapshotCursor: 0n, payoutCursor: 0n, accountCount: 0n, accountingComplete: true },
    } });
  }
  return { state, calls, writes, failRpc: error => { rpcFailure = error; }, async buttons() {
    queryResult = undefined; render();
    try { queryResult = { data: await options.queryFn() }; }
    catch (error) { queryResult = { isError: true }; throw error; }
    return nodes(render()).filter(node => node.type === "button").map(node => node.props);
  } };
}

test("overdue rollover exposes begin, partial pages and finish despite its derived sweep state", async () => {
  const h = harness();
  let buttons = await h.buttons();
  assert.deepEqual(buttons.map(b => b.children), ["Start epoch rollover"]);
  await buttons[0].onClick();
  assert.equal(h.writes.at(-1).functionName, "beginRollover");

  h.state.work = 1;
  for (const cursor of [0, 32, 64]) {
    h.state.cursor = cursor;
    buttons = await h.buttons();
    assert.deepEqual(buttons.map(b => b.children), ["Process rollover (32)"]);
    await buttons[0].onClick();
    assert.deepEqual(h.writes.at(-1).args, [32]);
    assert.equal(h.writes.at(-1).functionName, "rollPage");
  }
  h.state.cursor = 65;
  buttons = await h.buttons();
  const finish = buttons.find(b => b.children === "Finish epoch rollover");
  assert.ok(finish); await finish.onClick();
  assert.equal(h.writes.at(-1).functionName, "finishRollover");
  h.state.work = 0; h.state.end = 3_600n;
  assert.deepEqual(await h.buttons(), []);
  assert.ok(h.calls.every(c => c.blockNumber === 100n && c.address === engine && c.account === owner));
});

test("inactive, halted and unexpired markets do not offer rollover; RPC failures remain errors", async () => {
  for (const state of [{ active: false }, { halted: true }, { now: 999n }]) {
    const h = harness(); Object.assign(h.state, state);
    assert.deepEqual(await h.buttons(), []);
    assert.equal(h.calls.some(c => c.functionName === "beginRollover"), false);
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  h.failRpc(new Error("RPC temporarily unavailable"));
  await assert.rejects(h.buttons(), /RPC temporarily unavailable/);
  assert.equal(h.writes.length, 0);
});
