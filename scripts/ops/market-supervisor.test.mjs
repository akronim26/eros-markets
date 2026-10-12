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
  for (const text of ['publication-budget-exhausted', 'TESTNET_RELAY_BUDGET_EXHAUSTED', 'KEEPER_NEEDS_TEST_MON', 'Untracked sender nonce',
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
  const marker = path.join(directory, 'journal'), fixture = path.join(directory, 'worker.mjs'), keeper = path.join(directory, 'keeper.mjs');
  fs.writeFileSync(keeper, "setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n");
  fs.writeFileSync(fixture, `import fs from 'node:fs';
const marker=${JSON.stringify(marker)};
if (!fs.existsSync(marker)) { fs.writeFileSync(marker,'original journal'); console.error('RPC_UNAVAILABLE'); process.exit(1); }
if (fs.readFileSync(marker,'utf8')!=='original journal') throw Error('JOURNAL_CHANGED');
console.error('publication-budget-exhausted'); process.exit(78);\n`);
  const previousExit = process.exitCode;
  try {
    await supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'fixture', engine: '0x1111',
      coordination: path.relative(process.cwd(), directory), environment: {},
      children: [{ role: 'publisher', command: process.execPath, args: [fixture] },
        { role: 'keeper', command: process.execPath, args: [keeper] }] }] });
    const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    assert.equal(status.groups[0].status, 'blocked');
    assert.equal(status.status, 'blocked');
    assert.ok(status.stoppedAt);
    assert.equal(status.groups[0].children[0].restarts, 1);
    assert.equal(status.groups[0].children[1].status, 'stopped');
    assert.equal(status.groups[0].children[1].pid, null);
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

test('gas runway alerts are recorded before a worker reaches its stopping threshold', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-supervisor-runway-'));
  const fixture = path.join(directory, 'worker.mjs');
  fs.writeFileSync(fixture, "setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n");
  const MON = 10n ** 18n;
  const budget = { role: 'KEEPER', stopWei: MON / 2n, gasPerHour: 10n ** 9n }; // 2 MON/h: zero base fee + 2 gwei priority.
  let balance = 10n * MON;
  const client = { getBlock: async () => ({ number: 1n, baseFeePerGas: 0n }), getBalance: async () => balance };
  const finishing = supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'fixture', engine: '0x1111',
    coordination: path.relative(process.cwd(), directory), environment: {},
    children: [{ role: 'operations', command: process.execPath, args: [fixture] }] }],
    runway: { client, config: { launchMinutes: 120, alertMinutes: 30, checkIntervalMs: 50 },
      groups: [{ name: 'fixture', budgets: [budget], addresses: { KEEPER: '0xK' } }] } });
  try {
    await new Promise(resolve => setTimeout(resolve, 120));
    balance = MON / 2n + MON / 4n; // 0.25 MON headroom at 2 MON/h: 7.5 -> 7 minutes, below the 30-minute alert.
    await new Promise(resolve => setTimeout(resolve, 200));
    process.emit('SIGTERM');
    await finishing;
    const events = fs.readFileSync(path.join(directory, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const alerts = events.filter(e => e.gasRunwayAlert !== undefined);
    assert.equal(alerts.length, 1, 'one alert per level change, not one per check');
    assert.equal(alerts[0].gasRunwayAlert, true);
    assert.equal(alerts[0].role, 'KEEPER');
    assert.equal(alerts[0].minutesLeft, 7);
    assert.equal(alerts[0].level, 'alert');
    const status = JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    assert.equal(status.gasRunway.rows[0].level, 'alert');
    assert.equal(status.groups[0].status, 'stopped', 'an alert never stops workers by itself');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a fenced publisher restarts with backoff; the restart budget still applies', () => {
  assert.deepEqual(exitPolicy({ code: 1, text: 'Error: WRITER_FENCED\n    at worker.mjs:144' }),
    { action: 'restart', delayMs: 5_000, reason: 'writer-fenced' });
  assert.equal(exitPolicy({ code: 1, text: 'Error: PACKET_WRITER_FENCED', restarts: 2 }).delayMs, 20_000);
  assert.deepEqual(exitPolicy({ code: 1, text: 'Error: WRITER_FENCED', restarts: 5 }), { action: 'block', reason: 'restart-limit' });
});

function wakeFixture(name, exitDelayMs = 50) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `eros-supervisor-${name}-`));
  const fixture = path.join(directory, 'worker.mjs'), starts = path.join(directory, 'starts');
  fs.writeFileSync(fixture, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(starts)}, 'x');
setInterval(() => {}, 1000); process.once('SIGTERM', () => setTimeout(() => process.exit(0), ${exitDelayMs}));\n`);
  const group = { name: 'fixture', engine: '0xE1', coordination: path.relative(process.cwd(), directory), environment: {},
    children: [{ role: 'publisher', command: process.execPath, args: [fixture] }, { role: 'operations', command: process.execPath, args: [fixture] }] };
  return { directory, group, starts: () => fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').length : 0,
    status: () => JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8')),
    events: () => fs.readFileSync(path.join(directory, 'supervisor.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Generous limits: CI machines are slower than a laptop and these tests spawn real processes.
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await pause(20); }
  assert.fail('condition not reached');
}
// Always stop the supervisor, pass or fail: a leaked supervisor keeps its workers and the test
// runner's output pipe alive.
async function stop(finishing) { process.emit('SIGTERM'); await finishing; }

test('idle market sleeps with no workers and no exit, then a visitor wakes it on the same journals', async () => {
  const f = wakeFixture('wake');
  let seen = null, leverageReads = 0;
  const finishing = supervise({ stateDirectory: f.directory, secrets: [], groups: [f.group],
    wake: { url: 'https://x/api', pollMs: 40, idleMs: 1000 },
    readActivityImpl: async () => ({ '0xe1': seen }), anyLeveragedImpl: async () => { leverageReads++; return false; } });
  try {
    await until(() => f.status().groups[0].status === 'asleep');
    assert.equal(f.starts(), 2);
    assert.ok(leverageReads >= 1, 'leverage checked before sleeping');
    assert.deepEqual(f.status().groups[0].children.map(c => c.status), ['asleep', 'asleep']);
    await pause(200);
    assert.equal(f.status().groups[0].status, 'asleep', 'a sleeping market does not end the supervisor');
    seen = Date.now();
    await until(() => f.status().groups[0].status === 'running' && f.starts() === 4);
    assert.ok(f.events().some(e => e.waking && e.reason === 'visitor'));
    await stop(finishing);
    assert.equal(f.status().status, 'stopped');
  } finally { await stop(finishing); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a leveraged account or a failed leverage read keeps workers running', async () => {
  for (const leveraged of [async () => true, async () => { throw Error('RPC'); }]) {
    const f = wakeFixture('leveraged');
    const finishing = supervise({ stateDirectory: f.directory, secrets: [], groups: [f.group],
      wake: { url: 'https://x/api', pollMs: 30, idleMs: 1000 }, readActivityImpl: async () => ({ '0xe1': null }), anyLeveragedImpl: leveraged });
    try {
      await pause(300);
      assert.equal(f.status().groups[0].status, 'running');
      assert.equal(f.starts(), 2);
      assert.ok(f.events().some(e => e.awake && /leverage/.test(e.reason)));
    } finally { await stop(finishing); fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test('an unreadable activity route keeps an awake market awake and wakes a sleeping one', async () => {
  const f = wakeFixture('readfail');
  let fail = false;
  const finishing = supervise({ stateDirectory: f.directory, secrets: [], groups: [f.group],
    wake: { url: 'https://x/api', pollMs: 30, idleMs: 1000 },
    readActivityImpl: async () => { if (fail) throw Error('ACTIVITY_READ_FAILED'); return { '0xe1': null }; }, anyLeveragedImpl: async () => false });
  try {
    await until(() => f.status().groups[0].status === 'asleep');
    fail = true;
    await until(() => f.status().groups[0].status === 'running' && f.starts() === 4);
    assert.ok(f.events().some(e => e.waking && e.reason === 'activity-read-failed'));
    await pause(200);
    assert.equal(f.starts(), 4, 'stays awake while reads fail');
  } finally { await stop(finishing); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a visitor arriving during shutdown wakes the market as soon as the workers have stopped', async () => {
  // Workers take 800 ms to exit, so the sleeping state is observable on any machine.
  const f = wakeFixture('during', 800);
  let seen = null;
  const finishing = supervise({ stateDirectory: f.directory, secrets: [], groups: [f.group],
    wake: { url: 'https://x/api', pollMs: 20, idleMs: 1000 },
    readActivityImpl: async () => ({ '0xe1': seen }), anyLeveragedImpl: async () => false });
  try {
    await until(() => f.status().groups[0].status === 'sleeping');
    seen = Date.now();
    await until(() => f.events().some(e => e.waking && e.reason === 'visitor-during-shutdown'));
    await until(() => f.status().groups[0].status === 'running' && f.starts() === 4);
  } finally { await stop(finishing); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a fenced worker is restarted instead of blocking its market', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-supervisor-fenced-'));
  const fixture = path.join(directory, 'worker.mjs'), marker = path.join(directory, 'fenced');
  fs.writeFileSync(fixture, `import fs from 'node:fs';
if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('Error: WRITER_FENCED'); process.exit(1); }
setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0));\n`);
  const original = setTimeout;
  // Shorten only the 5 s fenced backoff so the test runs quickly.
  globalThis.setTimeout = (fn, ms, ...rest) => original(fn, ms === 5000 ? 10 : ms, ...rest);
  const finishing = supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'fixture', engine: '0x1111',
    coordination: path.relative(process.cwd(), directory), environment: {},
    children: [{ role: 'publisher', command: process.execPath, args: [fixture] }] }] });
  try {
    const status = () => JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    await until(() => status().groups[0].children[0].restarts === 1 && status().groups[0].children[0].status === 'running');
    assert.equal(status().groups[0].status, 'running');
  } finally { await stop(finishing); globalThis.setTimeout = original; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a worker that exits on an RPC provider internal error restarts; other RPC failures still block', () => {
  const internal = 'RpcRequestError: RPC Request failed.\n\nDetails: Internal error\n    details: "Internal error",\n   at x';
  assert.deepEqual(exitPolicy({ code: 1, text: internal }), { action: 'restart', delayMs: 2_000, reason: 'transient-read-failure' });
  assert.equal(exitPolicy({ code: 1, text: internal, restarts: 5 }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: 'RpcRequestError: RPC Request failed.\n    details: "execution reverted",' }).action, 'block');
  assert.equal(exitPolicy({ code: 1, text: 'Error: RELAY_JOURNAL_INTEGRITY\n details: "Internal error",' }).action, 'block');
});
