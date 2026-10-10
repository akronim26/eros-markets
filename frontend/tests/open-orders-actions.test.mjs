import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const owner = '0x2222222222222222222222222222222222222222';
const engine = '0x1111111111111111111111111111111111111111';
const source = readFileSync(new URL('../src/components/open-orders.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props) => ({ type, props });
const order = { id: 9, flags: 1, tick: 500, size: 1000n };
function render(patch = {}) {
  const sent = [], module = { exports: {} };
  const state = { owner: { address: owner, connected: true, wrongChain: false }, tx: { status: 'idle' },
    query: { data: { block: 100n, complete: true, orders: [order] }, isError: false },
    props: { engine, traderId: 8, block: 100n, readUnavailable: false }, ...patch };
  const dependencies = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/lib/order-reads': { useOrders: () => state.query },
    '@/lib/tx': { useTx: () => ({ state: state.tx, run: async (...args) => { sent.push(args); } }) },
    '@/lib/trader': { ownerTrader: () => ({ cancelAll: () => ({ functionName: 'cancelAll' }), cancel: id => ({ functionName: 'cancel', args: [id] }) }) },
    '@/lib/units': { lotsToClaims: String, tickToPrice: String },
    '@/lib/position-label': { orderSideLabel: () => 'Buy YES' },
    './wallet': { useOwner: () => state.owner }, './ui': { Button: 'button' },
  };
  new Function('require', 'module', 'exports', js)(id => dependencies[id] ?? {}, module, module.exports);
  const tree = module.exports.OpenOrders(state.props);
  const elements = value => !value || typeof value !== 'object' ? [] : Array.isArray(value)
    ? value.flatMap(elements) : [value, ...elements(value.props?.children)];
  const buttons = elements(tree).filter(node => node.type === 'button');
  return { sent, all: buttons.find(node => node.props.children === 'Cancel all'),
    single: buttons.find(node => node.props['aria-label'] === 'Cancel order 9') };
}

test('account-wide cancellation remains available while discovery loads or fails', async () => {
  for (const query of [{ data: undefined, isError: false }, { data: undefined, isError: true },
    { data: { block: 99n, orders: [order] }, isError: true }]) {
    const result = render({ query });
    assert.equal(result.all.props.disabled, false);
    await result.all.props.onClick();
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0][0], owner);
    assert.equal(result.sent[0][1][0].functionName, 'cancelAll');
    assert.equal(result.single, undefined, 'failed discovery cannot offer individual cancellation');
  }
});

test('both cancellation paths retain owner, chain, snapshot and pending-transaction guards', async () => {
  for (const patch of [
    { owner: { address: owner, connected: true, wrongChain: true } },
    { owner: { address: undefined, connected: true, wrongChain: false } },
    { props: { engine, traderId: 8, block: 100n, readUnavailable: true } },
    { props: { engine, traderId: 8, block: undefined } },
    { props: { engine, traderId: 0, block: 100n } },
    { tx: { status: 'pending' } }, { tx: { status: 'sent' } },
  ]) {
    const result = render(patch);
    assert.equal(result.all.props.disabled, true);
    assert.equal(result.single.props.disabled, true);
    // Dispatch guards matter even if a stale UI handler is invoked directly.
    await result.all.props.onClick(); await result.single.props.onClick();
    assert.deepEqual(result.sent, []);
  }
  const connected = render();
  assert.equal(connected.single.props.disabled, false);
  await connected.single.props.onClick();
  assert.equal(connected.sent[0][1][0].functionName, 'cancel');
});
