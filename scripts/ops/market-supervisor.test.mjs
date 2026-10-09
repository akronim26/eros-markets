import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exitPolicy, redact, supervise } from './market-supervisor.mjs';

test('only recognizable transient exits restart; money, identity, nonce and lock failures stop', () => {
  for (const text of ['HTTP_429', 'RPC_UNAVAILABLE', 'fetch failed', 'ECONNRESET']) {
    assert.equal(exitPolicy({ code: 1, text }).action, 'restart');
  }
  for (const text of ['publication-budget-exhausted', 'KEEPER_NEEDS_TEST_MON', 'Untracked sender nonce',
    'RELAY_JOURNAL_INTEGRITY', 'ENGINE_RUNTIME_MISMATCH', 'PUBLICATION_RECEIPT_NONCANONICAL',
    'EEXIST lock', 'Unknown failure', 'RPC_UNAVAILABLE while pending nonce requires reconciliation']) {
    assert.equal(exitPolicy({ code: 1, text }).action, 'block');
  }
  assert.equal(exitPolicy({ code: 0, text: 'RPC_UNAVAILABLE' }).action, 'block');
  assert.equal(exitPolicy({ code: 78, text: 'HTTP_429' }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: 'HTTP_429', restarts: 5 }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: 'HTTP_429', restarts: 3 }).delayMs, 16_000);
  assert.equal(exitPolicy({ code: 1, text: '{"nonce":513,"budget":{"maxTransactions":4000}}\nHTTP_429 timeout' }).action, 'restart');
  assert.equal(exitPolicy({ code: 1, text: 'RPC_POOL_UNAVAILABLE' }).action, 'restart');
  assert.equal(exitPolicy({ code: 1, text: 'HTTP_429 timeout\nError: UNSUPPORTED_SIGNER\n  at main (worker.mjs:10)' }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: '{"stoppedFor":"UNRECOGNIZED_BUDGET_POLICY"}\n    at main (worker.mjs:10)' }).action, 'block');
});

test('logs redact exact role secrets and provider URLs while retaining public evidence', () => {
  const key = `0x${'19'.repeat(32)}`, tx = `0x${'ab'.repeat(32)}`;
  const output = redact(`private key=${key}; https://rpc.example/path/API_SECRET?key=value hash=${tx}`, [key]);
  assert.ok(!output.includes(key)); assert.ok(!output.includes('API_SECRET'));
  assert.ok(output.includes(tx));
});

test('real child restart retains state; budget stop ends its group and removes only its own lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-supervisor-test-'));
  const marker = path.join(directory, 'journal'), fixture = path.join(directory, 'worker.mjs');
  fs.writeFileSync(fixture, `import fs from 'node:fs';
const marker=${JSON.stringify(marker)};
if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'original journal'); console.error('RPC_UNAVAILABLE'); process.exit(1); }
if (fs.readFileSync(marker,'utf8')!=='original journal') throw Error('JOURNAL_CHANGED');
console.error('publication-budget-exhausted'); process.exit(78);\n`);
  const previousExit = process.exitCode;
  try {
    await supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'fixture', engine: '0x1111',
      coordination: path.relative(process.cwd(), directory), environment: {},
      children: [{ role: 'publisher', command: process.execPath, args: [fixture] }] }] });
    const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    assert.equal(status.groups[0].status, 'blocked');
    assert.equal(status.status, 'blocked');
    assert.ok(status.stoppedAt);
    assert.equal(status.groups[0].children[0].restarts, 1);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'original journal');
    assert.equal(fs.existsSync(path.join(directory, 'supervisor.lock')), false);
    fs.writeFileSync(path.join(directory, 'supervisor.lock'), 'other operator');
    await assert.rejects(supervise({ stateDirectory: directory, secrets: [], groups: [] }), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(directory, 'supervisor.lock'), 'utf8'), 'other operator');
  } finally { process.exitCode = previousExit; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('graceful shutdown records stopped groups and children instead of stale running status', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-supervisor-stop-'));
  const fixture = path.join(directory, 'worker.mjs');
  fs.writeFileSync(fixture, "setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n");
  const finishing = supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'fixture', engine: '0x1111',
    coordination: path.relative(process.cwd(), directory), environment: {},
    children: [{ role: 'publisher', command: process.execPath, args: [fixture] }] }] });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    process.emit('SIGTERM');
    await finishing;
    const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    assert.equal(status.status, 'stopped'); assert.ok(status.stoppedAt);
    assert.equal(status.groups[0].status, 'stopped');
    assert.equal(status.groups[0].children[0].status, 'stopped');
    assert.equal(status.groups[0].children[0].pid, null);
    assert.equal(fs.existsSync(path.join(directory, 'supervisor.lock')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
