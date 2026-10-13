import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertServiceNotRetired, installServiceRetirement } from './service-retirement.mjs';
const marker = { schema: 'eros-market-native-retirement/1', planSetHash: '0x'+'ab'.repeat(32),
  engine: '0x'+'12'.repeat(20), recipient: '0x'+'34'.repeat(20),
  senders: ['45','56','67','78'].map(x => '0x'+x.repeat(20)) };
test('retirement fence is durable, idempotent only for exact evidence and blocks every restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eros-retirement-'));
  try {
    assertServiceNotRetired(dir); installServiceRetirement(dir, marker);
    const original = readFileSync(join(dir, 'retired.json'), 'utf8');
    installServiceRetirement(dir, marker);
    assert.equal(readFileSync(join(dir, 'retired.json'), 'utf8'), original);
    assert.throws(() => assertServiceNotRetired(dir), /RETIRED_MARKET_SERVICE/);
    assert.throws(() => installServiceRetirement(dir, { ...marker, planSetHash: '0x'+'cd'.repeat(32) }), /RETIREMENT_FENCE_CHANGED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an interrupted retirement write blocks signing instead of treating missing body as permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eros-retirement-'));
  try {
    writeFileSync(join(dir, 'retired.json'), '');
    assert.throws(() => assertServiceNotRetired(dir), /RETIRED_MARKET_SERVICE/);
    assert.throws(() => installServiceRetirement(dir, marker), /RETIREMENT_FENCE_CHANGED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
