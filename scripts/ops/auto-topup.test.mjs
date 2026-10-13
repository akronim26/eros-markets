import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { topUpConfig, planTopUps, sendTopUps, macNotifier, NoticeOnce } from './auto-topup.mjs';
import { supervise } from './market-supervisor.mjs';
import { MON } from './gas-runway.mjs';

const config = topUpConfig({ rootEnvFile: 'tmp/root.env' });
const now = Date.UTC(2026, 9, 12, 12);
const row = (role, minutes, level = minutes < 30 ? 'alert' : 'ok', address = '0x' + role.length.toString(16).padStart(40, '0')) =>
  ({ market: 'm', role, address, minutes, level });

test('defaults: keeper 30, publisher 15, makers 5 MON; 90 min trigger; 200 MON/day; 10 MON root reserve', () => {
  assert.equal(config.amountsWei.KEEPER, 30n * MON);
  assert.equal(config.amountsWei.PUBLISHER, 15n * MON);
  assert.equal(config.triggerMinutes, 90);
  assert.equal(config.dailyCapWei, 200n * MON);
  assert.equal(config.rootReserveWei, 10n * MON);
  assert.equal(topUpConfig(undefined), null);
  assert.throws(() => topUpConfig({}), /ROOT_ENV_FILE_REQUIRED/);
  assert.throws(() => topUpConfig({ rootEnvFile: 'x', amountsMon: { USER: 5 } }), /INVALID_TOPUP_AMOUNTS/);
});

test('refills only roles below the trigger or already stopped', () => {
  const plan = planTopUps({ rows: [row('KEEPER', 45), row('PUBLISHER', 600), row('MAKER_BUY', 0, 'stopped')], config,
    rootBalanceWei: 100n * MON, history: [], nowMs: now });
  assert.deepEqual(plan.sends.map(s => [s.role, s.amountWei]), [['KEEPER', 30n * MON], ['MAKER_BUY', 5n * MON]]);
  assert.deepEqual(plan.notices, []);
});

test('cooldown, daily cap and root reserve each stop a refill; the last two notify', () => {
  const keeper = row('KEEPER', 10);
  const recent = [{ atMs: now - 10 * 60_000, address: keeper.address, amountWei: 30n * MON }];
  assert.equal(planTopUps({ rows: [keeper], config, rootBalanceWei: 100n * MON, history: recent, nowMs: now }).sends.length, 0);
  const spent = [{ atMs: now - 3 * 3600_000, address: '0x1', amountWei: 180n * MON }];
  const capped = planTopUps({ rows: [keeper], config, rootBalanceWei: 1000n * MON, history: spent, nowMs: now });
  assert.equal(capped.sends.length, 0);
  assert.match(capped.notices[0].title, /cap reached/);
  const yesterday = [{ atMs: now - 24 * 3600_000, address: '0x1', amountWei: 180n * MON }];
  assert.equal(planTopUps({ rows: [keeper], config, rootBalanceWei: 1000n * MON, history: yesterday, nowMs: now }).sends.length, 1);
  const poor = planTopUps({ rows: [keeper], config, rootBalanceWei: 39n * MON, history: [], nowMs: now });
  assert.equal(poor.sends.length, 0);
  assert.match(poor.notices[0].title, /root wallet too low/);
  assert.equal(planTopUps({ rows: [keeper], config, rootBalanceWei: 40n * MON, history: [], nowMs: now }).sends.length, 1);
});

test('sending refuses a root with a pending transaction and stops at a failed receipt', async () => {
  const sends = [{ role: 'KEEPER', address: '0xk', amountWei: 1n }, { role: 'PUBLISHER', address: '0xp', amountWei: 1n }];
  const wallet = { sendTransaction: async ({ to }) => '0x' + to.slice(2).padStart(64, '0') };
  const counts = { latest: 5, pending: 6 };
  const client = { getTransactionCount: async ({ blockTag }) => counts[blockTag], waitForTransactionReceipt: async () => ({ status: 'success' }) };
  await assert.rejects(sendTopUps({ sends, client, wallet, root: '0xr' }), /ROOT_PENDING_TRANSACTION/);
  counts.pending = 5;
  assert.equal((await sendTopUps({ sends, client, wallet, root: '0xr' })).length, 2);
  client.waitForTransactionReceipt = async () => ({ status: 'reverted' });
  await assert.rejects(sendTopUps({ sends, client, wallet, root: '0xr' }), /TOPUP_REVERTED/);
});

test('notifications: osascript on macOS only, quotes stripped, each key shown once until cleared', () => {
  const calls = [];
  macNotifier({ platform: 'linux', run: (...a) => calls.push(a) })('t', 'm');
  assert.equal(calls.length, 0);
  macNotifier({ platform: 'darwin', run: (...a) => calls.push(a) })('Eros "x"', 'gas\\ low');
  assert.equal(calls[0][0], 'osascript');
  assert.ok(!calls[0][1][1].includes('"x"') && !calls[0][1][1].includes('\\'));
  const shown = [];
  const once = new NoticeOnce((t, m) => shown.push(t));
  assert.equal(once.show({ key: 'a:1', title: 'A', message: '' }), true);
  assert.equal(once.show({ key: 'a:1', title: 'A', message: '' }), false);
  once.clear('a:');
  once.show({ key: 'a:1', title: 'A', message: '' });
  assert.deepEqual(shown, ['A', 'A']);
});

test('a group stopped for low operator gas is refilled from root and restarted; the stop is notified', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-topup-'));
  const fixture = path.join(directory, 'worker.mjs'), starts = path.join(directory, 'starts');
  fs.writeFileSync(fixture, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(starts)}, 'x');
if (fs.readFileSync(${JSON.stringify(starts)}, 'utf8').length === 1) { console.log('{"waiting":"keeper gas wallet below policy minimum"}'); setInterval(() => {}, 1000); }
else setInterval(() => {}, 1000);
process.once('SIGTERM', () => process.exit(0));\n`);
  let balance = MON / 2n;
  const runwayClient = { getBlock: async () => ({ number: 1n, baseFeePerGas: 0n }), getBalance: async ({ address }) => address === '0xroot' ? 500n * MON : balance };
  const notified = [], sent = [];
  const finishing = supervise({ stateDirectory: directory, secrets: [], groups: [{ name: 'm', engine: '0x1111',
    coordination: path.relative(process.cwd(), directory), environment: {},
    children: [{ role: 'operations', command: process.execPath, args: [fixture] }] }],
    runway: { client: runwayClient, config: { launchMinutes: 60, alertMinutes: 15, checkIntervalMs: 50, publishIntervalSeconds: 70 },
      groups: [{ name: 'm', budgets: [{ role: 'KEEPER', stopWei: MON, gasPerHour: 10n ** 9n }], addresses: { KEEPER: '0xkeeper' } }] },
    topUp: { config, root: '0xroot', wallet: {}, client: runwayClient },
    sendTopUpsImpl: async ({ sends }) => { sent.push(...sends); balance += sends[0].amountWei; return sends.map(s => ({ ...s, hash: '0x' + 'ab'.repeat(32) })); },
    notify: (title, message) => notified.push(title) });
  try {
    const status = () => JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'));
    const end = Date.now() + 5000;
    while (Date.now() < end && !(fs.existsSync(starts) && fs.readFileSync(starts, 'utf8').length >= 2 && status().groups[0].status === 'running')) await new Promise(r => setTimeout(r, 25));
    assert.equal(fs.readFileSync(starts, 'utf8').length, 2, 'worker restarted after the refill');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].role, 'KEEPER');
    assert.equal(sent[0].amountWei, 30n * MON);
    assert.ok(notified.includes('Eros: market stopped'));
    const history = fs.readFileSync(path.join(directory, 'topups.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(history.length, 1);
    assert.equal(history[0].amountWei, String(30n * MON));
  } finally {
    process.emit('SIGTERM'); await finishing;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
