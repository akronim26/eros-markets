import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { Operations } from '../../oracle/services/market-ops/src/operations';
import { binding, manifestSchema } from '../../oracle/services/market-ops/src/schema';
import { keeperGasCeiling, boundedRolloverHelper, KeeperGasLimitExceeded, requireKeeperGas, runKeeperAction } from './keeper-gas-policy.mjs';
import { keeperActions } from './service-runtime-policy.mjs';

const require = createRequire(new URL('../../oracle/services/market-ops/package.json', import.meta.url));
const { keccak256 } = require('viem');
const address = '0x' + '11'.repeat(20), hash = '0x' + '22'.repeat(32), raw = '0x1234';
function fixture(ceiling = 3_000_000n) {
  const manifest = manifestSchema.parse({ chainId: 10143, engine: address, oracle: address, sender: address,
    engineCodeHash: hash, oracleCodeHash: hash, listingHash: hash, marketId: hash,
    gas: { samplePerp: 7_358_340, beginRollover: 200_000 } });
  let journal: any = { version: 1, binding: binding(manifest), completed: [] };
  let signed = 0, broadcasts = 0;
  let receipt: any = null;
  const refused: (bigint | undefined)[] = [];
  const transport: any = {
    snapshot: async () => ({ block: 100n, timestamp: 1000n, halted: false, scheduledT: 10000n,
      monitor: address, monitorRestricted: false, oracleState: 0,
      source: { id: hash, signer: address, rulesHash: hash, configured: true, lastSequence: 1n, lastObservedAt: 999n },
      rollover: { timestamp: 1000n, scheduledT: 10000n, halted: false, epochId: 1n, epochEnd: 1000n, work: 0, cursor: 0n, count: 0n } }),
    simulate: async () => true,
    prepare: async (call: { gas: bigint }) => {
      requireKeeperGas(call.gas, ceiling);
      signed++;
      return { rawTransaction: raw, hash: keccak256(raw) };
    },
    broadcast: async () => { broadcasts++; return keccak256(raw); },
    receipt: async () => receipt,
  };
  const operations = new Operations(manifest, transport, {
    read: () => structuredClone(journal), write: value => { journal = structuredClone(value); },
  });
  return { manifest, transport, setReceipt: (value: any) => { receipt = value; },
    get journal() { return journal; }, get signed() { return signed; }, get broadcasts() { return broadcasts; }, refused,
    run: (action: 'sample' | 'rollover' | 'liquidate') => runKeeperAction({ run: () => operations.tick({ action }, true),
      rolloverCeiling: manifest.rolloverHelper && BigInt(manifest.rolloverHelper.gasCeiling),
      hasPending: () => !!journal.pending, onLimit: error => { refused.push(error.gas); } }) };
}

test('operator gas ceiling keeps three-million default and rejects unbounded configuration', () => {
  expect(keeperGasCeiling()).toBe(3_000_000n);
  expect(keeperGasCeiling('8000000')).toBe(8_000_000n);
  expect(keeperGasCeiling('30000000')).toBe(30_000_000n);
  for (const value of ['', '0', '20999', '30000001', '8e6', '8000000.5', '-1', ' 8000000']) {
    expect(() => keeperGasCeiling(value)).toThrow('INVALID_KEEPER_MAX_GAS');
  }
});

test('refused sample leaves actual Operations journal unsigned and subsequent rollover can proceed', async () => {
  const f = fixture();
  expect(await f.run('sample')).toEqual({ limited: true });
  expect(f.signed).toBe(0); expect(f.broadcasts).toBe(0); expect(f.journal.pending).toBeUndefined();
  expect(f.refused).toEqual([7_358_340n]);
  const rollover = await f.run('rollover');
  expect(rollover.limited).toBe(false);
  if (!rollover.limited) expect(rollover.result.outcome).toBe('sent');
  expect(f.signed).toBe(1); expect(f.broadcasts).toBe(1); expect(f.journal.pending.action).toBe('rollover');
});

test('eight-million operator ceiling admits measured benchmark margin without charging the ceiling', async () => {
  const f = fixture(keeperGasCeiling('8000000'));
  const padded = 5_878_672n * 125n / 100n + 10_000n;
  expect(padded).toBe(7_358_340n);
  f.manifest.gas.samplePerp = Number(padded);
  const result = await f.run('sample');
  expect(result.limited).toBe(false); expect(f.signed).toBe(1); expect(f.refused).toEqual([]);
  // The ceiling authorizes the estimate; it does not replace the selected gas.
  expect(f.manifest.gas.samplePerp).toBe(7_358_340);
});

test('pending signed sample reconciles even after operator lowers the allowed gas', async () => {
  const f = fixture();
  f.journal.pending = { action: 'sample', requestId: binding(f.manifest), rawTransaction: raw,
    hash: keccak256(raw), plannedBlock: '99' };
  f.setReceipt({ status: 'success', block: 100n, finalized: true });
  const result = await f.run('sample');
  expect(result.limited).toBe(false);
  if (!result.limited) expect(result.result.outcome).toBe('finalized');
  expect(f.signed).toBe(0); expect(f.journal.pending).toBeUndefined(); expect(f.journal.lastSampleBlock).toBe('100');
});

test('unrelated failures and gas errors while a signed journal exists are never suppressed', async () => {
  for (const [error, pending] of [[Error('identity mismatch'), false], [new KeeperGasLimitExceeded(4_000_000n, 3_000_000n), true]] as const) {
    let reported = false;
    await expect(runKeeperAction({ run: async () => { throw error; }, hasPending: () => pending,
      onLimit: () => { reported = true; } })).rejects.toThrow(error.message);
    expect(reported).toBe(false);
  }
});


test('actual Operations reduces rollover pages to the runtime ceiling without changing journal identity', async () => {
  const f = fixture(8_000_000n);
  const configured = { address, codeHash: hash, maxPages: 32, gasCeiling: 30_000_000 };
  f.manifest.rolloverHelper = configured;
  const identity = binding(f.manifest);
  f.journal.binding = identity;
  f.manifest.rolloverHelper = boundedRolloverHelper(configured, 8_000_000n);
  expect(configured.gasCeiling).toBe(30_000_000);
  expect(f.manifest.rolloverHelper!.gasCeiling).toBe(8_000_000);
  expect(binding(f.manifest)).toBe(identity);
  const snapshot = f.transport.snapshot;
  f.transport.snapshot = async () => ({ ...await snapshot(), liquidation: { participants: 1024 } });
  const pages: number[] = [];
  f.transport.estimateGas = async (call: any) => { pages.push(call.args[4]); return BigInt(call.args[4]) * 2_000_000n + 1_000_000n; };
  const result = await f.run('rollover');
  expect(result.limited).toBe(false);
  if (!result.limited) expect(result.result.rolloverBatch).toMatchObject({ pages: 2, gasLimit: '6010000' });
  expect(pages.some(value => value > 2)).toBe(true);
  expect(f.signed).toBe(1); expect(f.refused).toEqual([]);
});

test('a rollover with no fitting page waits unsigned without stopping subsequent sampling', async () => {
  const f = fixture(8_000_000n);
  f.manifest.rolloverHelper = { address, codeHash: hash, maxPages: 32, gasCeiling: 8_000_000 };
  f.journal.binding = binding(f.manifest);
  const snapshot = f.transport.snapshot;
  f.transport.snapshot = async () => ({ ...await snapshot(), liquidation: { participants: 1024 } });
  f.transport.estimateGas = async () => 9_000_000n;
  expect(await f.run('rollover')).toEqual({ limited: true });
  expect(f.signed).toBe(0); expect(f.journal.pending).toBeUndefined();
  expect(f.refused).toEqual([undefined]);
  expect((await f.run('sample')).limited).toBe(false);
  expect(f.signed).toBe(1);
});

test('scheduled liquidation shares the existing pending journal and gives the following sample its turn', async () => {
  const f = fixture(8_000_000n);
  f.manifest.gas.liquidate = 400_000;
  const original = f.transport.snapshot;
  f.transport.snapshot = async () => ({ ...await original(),
    liquidation: { participants: 1, accountingState: 0, capLots: 100n, remainingLots: 100n },
    rollover: { timestamp: 1000n, scheduledT: 10000n, halted: false, epochId: 1n, epochEnd: 2000n, work: 0, cursor: 0n, count: 0n } });
  f.transport.simulate = async (call: any) => call.action === 'liquidate'
    ? { mode: 1, result: 1, bookLots: 10n, pairedLots: 0n, reason: 0 } : true;
  const due = keeperActions({ liquidationEnabled: true, nextLiquidationAt: 0, now: 10_000 });
  expect(due).toEqual(['rollover', 'liquidate', 'sample']);
  const rollover = await f.run(due[0]);
  expect(!rollover.limited && rollover.result.outcome).toBe('no-work');
  const liquidation = await f.run(due[1]);
  expect(!liquidation.limited && liquidation.result.outcome).toBe('sent');
  expect(f.journal.pending.action).toBe('liquidate'); expect(f.signed).toBe(1);
  // Even if a caller asks for sampling next, the shared journal reconciles the
  // exact liquidation instead of allocating another nonce.
  const waiting = await f.run('sample');
  expect(!waiting.limited && waiting.result.action).toBe('liquidate'); expect(f.signed).toBe(1);
  f.setReceipt({ status: 'success', block: 100n, finalized: true });
  const complete = await f.run('sample');
  expect(!complete.limited && complete.result.outcome).toBe('finalized');
  expect(f.journal.pending).toBeUndefined();
  expect(keeperActions({ liquidationEnabled: true, nextLiquidationAt: 20000, now: 10001 })).toEqual(['rollover', 'sample']);
  const sample = await f.run('sample');
  expect(!sample.limited && sample.result.action).toBe('sample'); expect(f.signed).toBe(2);
});
