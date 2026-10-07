import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { zeroAddress, zeroHash } from 'viem';
import { client } from '../src/lib/public-client.ts';
import { readPinned, pinnedReadCurrent } from '../src/lib/pinned-read.ts';

// Register queries from actual production components, replacing rendering and
// wallet providers. The delayed RPC and cache behavior below are real.
function options(file, name, props, count = 1) {
  const captured = [], stop = {};
  const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const deps = {
    react: { useState: value => [value, () => {}] },
    '@tanstack/react-query': { useQuery: value => { captured.push(value); if (captured.length === count) throw stop; return {}; } },
    viem: { zeroAddress, zeroHash, parseAbi: value => value },
    '@/lib/reads': { client }, '@/lib/pinned-read': { readPinned, pinnedReadCurrent },
    '@/lib/tx': { useTx: () => ({ state: { status: 'idle' } }) },
    './wallet': { useOwner: () => ({ address: props.owner ?? zeroAddress }) },
    '@/config/deployment': { deployment: { oracle: { resolutionOracle: zeroAddress } } },
    '@/lib/oracle-actions': { ORACLE_ACTIONS: [] }, './feedback': { useFieldErrors: () => ({}) },
    '@/lib/capabilities': { verifiedProfile: () => ({}) },
    '@/lib/margin-lens': { healthAt: async () => ({ status: 1, mmQ: 1n, markEquityQ: 2n }) },
  };
  new Function('require', 'module', 'exports', js)(key => deps[key] ?? {}, module, module.exports);
  try { module.exports[name](props); } catch (error) { if (error !== stop) throw error; }
  assert.equal(captured.length, count);
  return captured;
}
const market = block => ({ block, active: false, halted: false, participants: 0n, epoch: { id: 1n, end: 999999n }, risk: { accountingState: 0, asOfTime: 100n, pendingWork: 0, secsToT: 10000n }, settlement: {}, listing: { scheduledT: 999999n, deploymentCapX: 5n, marketId: zeroHash }, profile: { profileHash: zeroHash } });
const oracle = block => ({ block, id: zeroHash, oracle: { marketRegistry: zeroAddress, resolutionOracle: zeroAddress }, bond: 1n, liveness: 10n, resolution: { state: 0, trustSetId: 0n, assertionId: zeroHash, assertionVenue: zeroAddress, attempts: 0, rejectedMask: 0 } });
const trader = { traderId: 1, account: { preview: { cashQ: 1n, positionLots: 1n, e0Q: -1n, e1Q: 1n, id: { markAvailable: true } } } };
for (const [name, build] of [
  ['operations', block => options('operations-panel.tsx', 'OperationsPanel', { engine: zeroAddress, m: market(block) }, 2)[0]],
  ['liquidation candidates', block => options('operations-panel.tsx', 'OperationsPanel', { engine: zeroAddress, m: market(block) }, 2)[1]],
  ['oracle actions', block => options('oracle-actions.tsx', 'OracleActions', { data: oracle(block) })[0]],
  ['risk lens', block => options('risk-panel.tsx', 'RiskPanel', { m: market(block), t: trader })[0]],
]) test(`${name}: slow RPC completes across advancing heads with original block provenance`, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const blocks = [];
  t.mock.method(client, 'getBlock', async ({ blockNumber }) => { blocks.push(blockNumber); await gate; return { number: blockNumber, hash: zeroHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }; });
  t.mock.method(client, 'readContract', async () => 1n);
  t.mock.method(client, 'multicall', async () => []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const first = qc.fetchQuery(build(100n)), next = qc.fetchQuery(build(101n)); release();
    const [a, b] = await Promise.all([first, next]);
    assert.equal(a, b); assert.equal(a.block, 100n); assert.ok(blocks.every(block => block === 100n));
    assert.equal(pinnedReadCurrent(a, 101n), true);
    assert.equal(pinnedReadCurrent(a, 101n, Number(a.timestamp) * 1000 + 30001), false);
    assert.equal((await qc.fetchQuery({ ...build(102n), staleTime: 0 })).block, 102n);
  } finally { qc.clear(); }
});
test('owner, phase, oracle assertion and account changes isolate snapshots', () => {
  const op = (m, owner) => options('operations-panel.tsx', 'OperationsPanel', { engine: zeroAddress, m, owner }, 2)[0].queryKey;
  assert.notDeepEqual(op(market(1n), zeroAddress), op(market(1n), `0x${'1'.repeat(40)}`));
  assert.notDeepEqual(op(market(1n), zeroAddress), op({ ...market(1n), epoch: { id: 2n, end: 999999n } }, zeroAddress));
  const a = oracle(1n), b = { ...a, resolution: { ...a.resolution, assertionId: `0x${'1'.repeat(64)}` } };
  assert.notDeepEqual(options('oracle-actions.tsx', 'OracleActions', { data: a })[0].queryKey, options('oracle-actions.tsx', 'OracleActions', { data: b })[0].queryKey);
  assert.notDeepEqual(options('oracle-actions.tsx', 'OracleActions', { data: a })[0].queryKey, options('oracle-actions.tsx', 'OracleActions', { data: { ...a, oracle: { ...a.oracle, resolutionOracle: `0x${'2'.repeat(40)}` } } })[0].queryKey);
  assert.notDeepEqual(options('risk-panel.tsx', 'RiskPanel', { m: market(1n), t: trader })[0].queryKey, options('risk-panel.tsx', 'RiskPanel', { m: market(1n), t: { ...trader, traderId: 2 } })[0].queryKey);
});

test('an archived oracle action signs against the oracle carried by its verified snapshot', async () => {
  const archivedOracle = `0x${'5'.repeat(40)}`, owner = `0x${'6'.repeat(40)}`;
  const data = { ...oracle(100n), claim: '0x', oracle: { marketRegistry: `0x${'4'.repeat(40)}`, resolutionOracle: archivedOracle } };
  const calls = [], module = { exports: {} };
  const source = readFileSync(new URL('../src/components/oracle-actions.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const deps = {
    'react/jsx-runtime': { jsx, jsxs: jsx }, react: { useState: value => [value, () => {}] },
    '@tanstack/react-query': { useQuery: () => ({ data: { value: { allowed: [true] }, block: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) } }) },
    viem: { zeroAddress, zeroHash, parseAbi: value => value },
    '@/lib/pinned-read': { readPinned, pinnedReadCurrent }, '@/lib/reads': { client },
    '@/lib/tx': { useTx: () => ({ state: { status: 'idle' }, run: async (...args) => { calls.push(args); } }) },
    './wallet': { useOwner: () => ({ address: owner, wrongChain: false }) },
    '@/config/deployment': { deployment: { oracle: { resolutionOracle: zeroAddress } } },
    '@/lib/oracle-actions': { ORACLE_ACTIONS: [['finalizeMarket', 'Finalize']] },
    './feedback': { useFieldErrors: () => ({}) }, './ui': { Button: 'button' },
  };
  new Function('require', 'module', 'exports', js)(key => deps[key] ?? {}, module, module.exports);
  const tree = module.exports.OracleActions({ data });
  const elements = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(elements) : [value, ...elements(value.props?.children)];
  const button = elements(tree).find(node => node.type === 'button' && node.props.children === 'Finalize');
  assert.ok(button); assert.equal(button.props.disabled, false);
  await button.props.onClick();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], owner);
  assert.equal(calls[0][1][0].address, archivedOracle);
  assert.equal(calls[0][1][0].functionName, 'finalizeMarket');
  assert.deepEqual(calls[0][1][0].args, [data.id]);
});
