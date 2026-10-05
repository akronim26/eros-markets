import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Journal } from '../src/journal.js';
import { Worker } from '../src/worker.js';
import { rulesHash } from '../src/rules.js';
import { localFactoryFixture, localSourceConfig, requireLoopback, startFixtureSource } from '../scripts/local-factory-fixture.js';

test('local factory rules bind each market and halt while remaining disabled fixtures', () => {
  const fixture = localFactoryFixture(1800000000n);
  assert.notEqual(fixture.markets.demo.sourceRulesHash, fixture.markets.terminal.sourceRulesHash);
  assert.notEqual(fixture.markets.demo.sourceRulesHash, localFactoryFixture(1800000001n).markets.demo.sourceRulesHash);
  for (const market of Object.values(fixture.markets)) {
    assert.equal(market.config.enabled, false);
    assert.equal(market.config.destination, null);
    assert.equal(rulesHash(market.rules), market.sourceRulesHash);
  }
});

test('local fixture refuses public endpoints and credential-bearing loopback URLs', () => {
  for (const endpoint of ['https://127.0.0.1:8545', 'http://example.com', 'http://user:pass@127.0.0.1',
    'http://127.0.0.1/token', 'http://127.0.0.1/?key=secret']) assert.throws(() => requireLoopback(endpoint));
  requireLoopback('http://127.0.0.1:8545');
  requireLoopback('http://localhost:8545');
});

test('actual collector consumes localhost source and fails closed on stale, absent, thin and failed data', async () => {
  let clock = 1800000000000n;
  const source = await startFixtureSource(() => clock);
  const directory = mkdtempSync(join(tmpdir(), 'eros-local-source-'));
  const journal = new Journal(join(directory, 'source.sqlite'));
  const worker = new Worker(localSourceConfig('demo'), source.provider('demo'), journal, 'test-owner', () => clock);
  try {
    const valid = await worker.poll();
    assert.equal(valid.inspection.status, 'COLLECTING');
    assert.equal(valid.inspection.summary?.priceWad, 500000000000000000n);
    source.setMode('demo', 'stale'); clock += 31000n;
    assert.equal((await worker.poll()).inspection.reason, 'STALE_OR_FUTURE_SOURCE_TIME');
    source.setMode('demo', 'missing-time');
    assert.equal((await worker.poll()).inspection.reason, 'MISSING_OR_BAD_SOURCE_TIME');
    source.setMode('demo', 'thin');
    assert.equal((await worker.poll()).inspection.status, 'INVALID_DEPTH');
    source.setMode('demo', 'outage');
    assert.equal((await worker.poll()).inspection.reason, 'FIXTURE_HTTP_503');
    source.setMode('demo', 'valid');
    assert.equal((await worker.poll()).inspection.status, 'COLLECTING');
    assert.ok(source.requestCount() >= 8);
    assert.equal(journal.verify(), true);
  } finally {
    worker.releaseLease(); journal.close(); await source.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('eros-local-source-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
