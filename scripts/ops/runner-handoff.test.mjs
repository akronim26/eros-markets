import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pack, accept, assertRunnerAllowed, assertStopped, HANDED_OFF, ACCEPTED } from './runner-handoff.mjs';
import { containerPrivatePath, supervise } from './market-supervisor.mjs';

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-handoff-'));
  const market = 'tmp/run/m1', state = 'tmp/run/supervisor';
  for (const dir of [market + '/services/pricefeed-journals', market + '/services/keys', market + '/coordination', state])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body);
  write(market + '/services/pricefeed-journals/relay.sqlite', 'relay journal');
  write(market + '/services/market-ops-journal.json', '{"pending":null}');
  write(market + '/maker-journal.json', '{"completed":[]}');
  write(market + '/roles.env', 'KEEPER_PRIVATE_KEY=0xsecret');
  write(market + '/services/keys/transaction-password', 'secret');
  write(state + '/status.json', JSON.stringify({ status: 'stopped', groups: [{ children: [{ pid: null }] }] }));
  write('tmp/run/supervisor.json', JSON.stringify({ stateDirectory: state, markets: [{ name: 'm1', privateDirectory: market }] }));
  return { root, market, state, write, none: () => '' };
}
const bundleOf = h => path.join(h.root, 'bundle.tgz');

test('pack refuses a running supervisor, a lock, a worker process or an existing hand-off', () => {
  const h = host();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(h.root, 'tmp/run/supervisor.json'), 'utf8'));
    h.write(h.state + '/supervisor.lock', '1');
    assert.throws(() => assertStopped({ root: h.root, config, processes: h.none }), /SUPERVISOR_LOCK_PRESENT/);
    fs.rmSync(path.join(h.root, h.state, 'supervisor.lock'));
    h.write(h.state + '/status.json', JSON.stringify({ status: 'running', groups: [] }));
    assert.throws(() => assertStopped({ root: h.root, config, processes: h.none }), /SUPERVISOR_NOT_STOPPED/);
    h.write(h.state + '/status.json', JSON.stringify({ status: 'stopped', groups: [] }));
    assert.throws(() => assertStopped({ root: h.root, config, processes: () => `12 node scripts/e2e/makers.mjs x ${h.market} rpc` }), /WORKER_PROCESS_PRESENT/);
    assert.throws(() => assertStopped({ root: h.root, config, processes: () => '13 node scripts/ops/market-supervisor.mjs run cfg' }), /WORKER_PROCESS_PRESENT/);
    h.write(h.market + '/maker-journal.json.lock', '1');
    assert.throws(() => assertStopped({ root: h.root, config, processes: h.none }), /JOURNAL_LOCK_PRESENT/);
    fs.rmSync(path.join(h.root, h.market, 'maker-journal.json.lock'));
    pack({ root: h.root, configPath: 'tmp/run/supervisor.json', bundlePath: bundleOf(h), processes: h.none });
    assert.throws(() => pack({ root: h.root, configPath: 'tmp/run/supervisor.json', bundlePath: bundleOf(h), processes: h.none }), /ALREADY_HANDED_OFF/);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('the bundle carries journals but never secrets, and fences the old host', () => {
  const h = host();
  try {
    const result = pack({ root: h.root, configPath: 'tmp/run/supervisor.json', bundlePath: bundleOf(h), processes: h.none });
    const listed = execFileSync('tar', ['-tzf', bundleOf(h)], { encoding: 'utf8' }).split('\n');
    assert.ok(listed.includes(h.market + '/services/pricefeed-journals/relay.sqlite'));
    assert.ok(listed.includes(h.market + '/services/market-ops-journal.json'));
    assert.ok(!listed.some(f => /roles\.env|services\/keys/.test(f)), 'no keys or role secrets in the bundle');
    assert.equal(result.files, 4);
    assert.ok(fs.existsSync(path.join(h.root, h.state, HANDED_OFF)));
    assert.throws(() => assertRunnerAllowed({ stateDirectory: path.join(h.root, h.state), containerMode: false }), /RUNNER_HANDED_OFF/);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('accept requires every file intact and refuses foreign journals; the container needs acceptance', () => {
  const h = host(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-render-'));
  try {
    const { manifestRel } = pack({ root: h.root, configPath: 'tmp/run/supervisor.json', bundlePath: bundleOf(h), processes: h.none });
    const extract = () => { fs.rmSync(path.join(target, 'tmp'), { recursive: true, force: true }); execFileSync('tar', ['-xzf', bundleOf(h), '-C', target]); };
    const stateDirectory = path.join(target, h.state);
    extract();
    fs.appendFileSync(path.join(target, h.market, 'services/pricefeed-journals/relay.sqlite'), 'x');
    assert.throws(() => accept({ root: target, manifestRel }), /HANDOFF_FILE_CHANGED/);
    extract();
    fs.rmSync(path.join(target, h.market, 'maker-journal.json'));
    assert.throws(() => accept({ root: target, manifestRel }), /HANDOFF_FILE_MISSING/);
    extract();
    fs.writeFileSync(path.join(target, h.market, 'services/pricefeed-journals/packets.sqlite'), 'stale');
    assert.throws(() => accept({ root: target, manifestRel }), /UNEXPECTED_JOURNAL_ON_NEW_HOST/);
    extract();
    assert.throws(() => assertRunnerAllowed({ stateDirectory, containerMode: true }), /HANDOFF_NOT_ACCEPTED/);
    assert.deepEqual(accept({ root: target, manifestRel }), { accepted: true, files: 4 });
    assert.ok(fs.existsSync(path.join(stateDirectory, ACCEPTED)));
    assertRunnerAllowed({ stateDirectory, containerMode: true });
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});

test('a handed-off supervisor refuses to take its lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-handedoff-'));
  try {
    fs.writeFileSync(path.join(directory, HANDED_OFF), '{}');
    await assert.rejects(supervise({ stateDirectory: directory, secrets: [], groups: [] }), /RUNNER_HANDED_OFF/);
    assert.equal(fs.existsSync(path.join(directory, 'supervisor.lock')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('container path guard accepts only paths under the ignored tmp mount', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-image-'));
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n/tmp/\n');
    assert.equal(containerPrivatePath('tmp/a/b.json', repo), path.join(repo, 'tmp/a/b.json'));
    assert.throws(() => containerPrivatePath('tmpx/a', repo), /IGNORED_PRIVATE_PATH_REQUIRED/);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    assert.throws(() => containerPrivatePath('tmp/a', repo), /IGNORED_PRIVATE_PATH_REQUIRED/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('entrypoint installs secret files as private regular files, never links', async () => {
  const { installSecrets } = await import('./render-entrypoint.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eros-entry-')), secrets = path.join(repo, 'secrets');
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), '/tmp/\n');
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'rpc-pool.env'), 'MONAD_TESTNET_RPC=x\n');
    fs.writeFileSync(path.join(secrets, 'm1.roles.env'), 'KEEPER_PRIVATE_KEY=0x1\n');
    const src = path.join(repo, 'keysrc'); fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'transaction-password'), 'pw');
    fs.writeFileSync(path.join(secrets, 'm1.keys.tgz.b64'), execFileSync('tar', ['-czf', '-', '-C', src, '.']).toString('base64'));
    const config = { rpcEnvFile: 'tmp/rpc/rpc-pool.env', markets: [{ name: 'm1', privateDirectory: 'tmp/run/m1' }] };
    installSecrets({ repository: repo, config, secrets });
    for (const rel of ['tmp/rpc/rpc-pool.env', 'tmp/run/m1/roles.env', 'tmp/run/m1/services/keys/transaction-password']) {
      const stat = fs.lstatSync(path.join(repo, rel));
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), rel);
      assert.equal(stat.mode & 0o077, 0, rel);
    }
    fs.rmSync(path.join(secrets, 'm1.roles.env'));
    assert.throws(() => installSecrets({ repository: repo, config, secrets }), /SECRET_FILE_MISSING:m1.roles.env/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
