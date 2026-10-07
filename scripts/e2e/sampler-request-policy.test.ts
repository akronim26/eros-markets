import { test, expect } from 'bun:test';
import { createRequire } from 'node:module';
import { Operations, type Transport } from '../../oracle/services/market-ops/src/operations';
import { binding, manifestSchema } from '../../oracle/services/market-ops/src/schema';
import type { Journal } from '../../oracle/services/market-ops/src/store';
import { sampleCadenceRemaining, isFinalizedSample } from './sampler-request-policy.mjs';

const require = createRequire(new URL('../../oracle/services/market-ops/package.json', import.meta.url));
const { keccak256 } = require('viem');
const address = `0x${'11'.repeat(20)}`, hash = `0x${'22'.repeat(32)}`, raw = '0x1234';

test('an early request survives cadence skips and restart until its sample is finalized', async () => {
  const manifest = manifestSchema.parse({ chainId: 10143, engine: address, oracle: address, sender: address,
    engineCodeHash: hash, oracleCodeHash: hash, listingHash: hash, marketId: hash,
    sampleEveryBlocks: '45', gas: { samplePerp: 100_000 } });
  let journal: Journal = { version: 1, binding: binding(manifest), completed: [], lastSampleBlock: '100' };
  let block = 101n, sent = 0;
  let receipt: Awaited<ReturnType<Transport['receipt']>> = null;
  const store = { read: () => structuredClone(journal), write: (value: Journal) => { journal = structuredClone(value); } };
  const transport = {
    snapshot: async () => ({ block, timestamp: 1000n, halted: false, scheduledT: 10_000n }),
    simulate: async () => true,
    prepare: async () => ({ rawTransaction: raw, hash: keccak256(raw) }),
    broadcast: async () => { sent++; return keccak256(raw); },
    receipt: async () => receipt,
  } as Transport;
  const request = { id: '27' };
  const acknowledgements: string[] = [];
  const tick = async (ops: Operations, action: 'sample' | 'rollover' = 'sample') => {
    const result = await ops.tick({ action }, true);
    if (isFinalizedSample(result)) acknowledgements.push(request.id);
    return result;
  };
  const first = new Operations(manifest, transport, store);
  expect(sampleCadenceRemaining(journal.lastSampleBlock, block, manifest.sampleEveryBlocks)).toBe(44n);
  expect((await tick(first)).outcome).toBe('cadence');
  block = 144n;
  expect((await tick(first)).outcome).toBe('cadence');
  expect(acknowledgements).toEqual([]);
  expect(sent).toBe(0);
  const resumed = new Operations(manifest, transport, store);
  block = 145n;
  expect(sampleCadenceRemaining(journal.lastSampleBlock, block, manifest.sampleEveryBlocks)).toBe(0n);
  expect((await tick(resumed)).outcome).toBe('sent');
  receipt = { status: 'success', block: 146n, finalized: false };
  expect((await tick(resumed)).outcome).toBe('pending');
  expect(acknowledgements).toEqual([]);
  receipt.finalized = true;
  // The wrapper starts each cycle with rollover; reconciliation must still ACK the sample.
  expect((await tick(resumed, 'rollover')).outcome).toBe('finalized');
  expect(acknowledgements).toEqual(['27']);
  expect(journal.lastSampleBlock).toBe('146');
  expect(sent).toBe(1);
});

test('first sample is eligible and unrelated finalized work cannot satisfy a sample request', () => {
  expect(sampleCadenceRemaining(undefined, 1n, 45n)).toBe(0n);
  expect(sampleCadenceRemaining('100', 200n, 45n)).toBe(0n);
  for (const result of [{ outcome: 'cadence' }, { outcome: 'finalized', action: 'rollover' },
    { outcome: 'sent', action: 'sample' }, { outcome: 'pending', action: 'sample' }]) {
    expect(isFinalizedSample(result)).toBe(false);
  }
});
