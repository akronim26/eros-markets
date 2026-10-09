/** Build/start only after reviewed migration. Never stops an existing service or changes env files. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
process.chdir(root);
const frontend = path.join(root, 'frontend');
const node = '/private/tmp/eros-ci03-tools/node-v22.23.3-darwin-arm64/bin/node';
const next = path.join(frontend, 'node_modules/next/dist/bin/next');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const files = ['public-manifest.json', 'archived-deployments.json', 'market-metadata.json', 'risk-calibrations.json'];
const fingerprints = () => Object.fromEntries([
  ...files.map(f => 'frontend/src/config/' + f), 'frontend/src/abi/engine.ts', 'frontend/next.config.ts',
  'frontend/.env.local', 'frontend/package.json',
].map(p => [p, hash(p)]));
const save = (p, value) => {
  fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
};
function listener() {
  try { return execFileSync('lsof', ['-nP', '-iTCP:3100', '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (error) { if (error.status === 1) return ''; throw error; }
}
function absent() { if (listener()) throw Error('STOP_EXISTING_FRONTEND_BEFORE_BUILD_OR_START'); }
function assertMigration(directory) {
  const state = read(directory + '/migration-stage.json');
  if (state.schema !== 'eros-fast-public-migration/1' || state.status !== 'applied') throw Error('APPLIED_MIGRATION_REQUIRED');
  const current = Object.fromEntries(files.map(f => [f, hash('frontend/src/config/' + f)]));
  if (!equal(current, state.installedHashes)) throw Error('FRONTEND_SELECTION_CHANGED');
  const live = { configSha256: hash('tmp/redeploy-audit-20261007/indexer/config.yaml'),
    environmentSha256: hash('tmp/redeploy-audit-20261007/indexer/indexer.env') };
  if (!equal(live, state.liveIndexer)) throw Error('LIVE_INDEXER_CHANGED');
}
async function main() {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!['build', 'start'].includes(command) || extra.length || !directory?.startsWith('tmp/') || directory.includes('..')
    || fs.realpathSync(directory) !== path.resolve(root, directory)) throw Error('EXPECTED_BUILD_OR_START_AND_DIRECT_MIGRATION_DIRECTORY');
  if (execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() !== 'v22.23.3') throw Error('REVIEWED_NODE_VERSION_REQUIRED');
  const lock = directory + '/frontend-operation.lock';
  fs.mkdirSync(lock);
  try {
    assertMigration(directory); absent();
    const local = parseEnv(fs.readFileSync('frontend/.env.local', 'utf8'));
    if (process.env.EROS_E2E_MANIFEST || process.env.EROS_E2E_RPC_URL || local.EROS_E2E_MANIFEST || local.EROS_E2E_RPC_URL)
      throw Error('PUBLIC_BUILD_REJECTS_LOCAL_TEST_OVERRIDES');
    const selected = read('frontend/src/config/public-manifest.json');
    if (local.NEXT_PUBLIC_CHAIN_ID !== '10143' || !local.NEXT_PUBLIC_PRIVY_APP_ID
      || local.NEXT_PUBLIC_INDEXER_DEPLOYMENT?.toLowerCase() !== `10143:${selected.contracts.MarketRegistry.address.toLowerCase()}`
      || local.NEXT_PUBLIC_INDEXER_URL !== 'http://127.0.0.1:8083/v1/graphql') throw Error('FRONTEND_ENVIRONMENT_BINDING_CHANGED');
    const env = { ...process.env, ...local, NODE_ENV: 'production', PATH: path.dirname(node) + ':' + process.env.PATH };
    const inputs = fingerprints(), buildPath = directory + '/frontend-build.json';
    if (command === 'build') {
      const building = { passed: false, status: 'building', at: new Date().toISOString(), node: 'v22.23.3', inputs };
      save(buildPath, building); // A later failed rebuild must invalidate any earlier successful report.
      const output = fs.openSync(directory + '/frontend-build.log', 'a', 0o600);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          const child = spawn(node, [next, 'build', '--webpack'], { cwd: frontend, env, stdio: ['ignore', output, output] });
          child.once('spawn', () => save(buildPath, { ...building, pid: child.pid }));
          child.once('error', () => reject(Error('FRONTEND_BUILD_START_FAILED')));
          child.once('exit', code => resolve(code));
        });
      } finally { fs.closeSync(output); }
      if (code !== 0) throw Error('FRONTEND_BUILD_FAILED_SEE_PRIVATE_LOG');
      assertMigration(directory); absent();
      if (!equal(inputs, fingerprints())) throw Error('FRONTEND_INPUT_CHANGED_DURING_BUILD');
      const buildId = fs.readFileSync('frontend/.next/BUILD_ID', 'utf8').trim();
      save(buildPath, { passed: true, at: new Date().toISOString(), node: 'v22.23.3', buildId, inputs,
        command: 'next build --webpack', testsRun: false, servicesRestarted: false });
      console.log(JSON.stringify({ built: true, buildId, serverStarted: false, log: directory + '/frontend-build.log' }));
      return;
    }
    const build = read(buildPath), buildId = fs.readFileSync('frontend/.next/BUILD_ID', 'utf8').trim();
    if (!build.passed || build.node !== 'v22.23.3' || build.buildId !== buildId || !equal(build.inputs, inputs))
      throw Error('MATCHING_COMPLETED_FRONTEND_BUILD_REQUIRED');
    absent();
    const output = fs.openSync(directory + '/frontend-server.log', 'a', 0o600);
    let child;
    try { child = spawn(node, [next, 'start', '-p', '3100'], { cwd: frontend, env, detached: true, stdio: ['ignore', output, output] }); }
    finally { fs.closeSync(output); }
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(Error('FRONTEND_START_FAILED'))); });
    const record = { pid: child.pid, port: 3100, startedAt: new Date().toISOString(), processMode: 'detached',
      node: 'v22.23.3', buildId, activeMarkets: selected.markets.length, log: directory + '/frontend-server.log', status: 'starting' };
    save(directory + '/frontend-running.json', record);
    // Record the started PID immediately so a timeout/crash never leaves an unidentified server.
    fs.writeFileSync('tmp/redeploy-20261009/frontend-server.pid', String(child.pid) + '\n', { mode: 0o600 });
    child.unref();
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const pids = listener().split(/\s+/).filter(Boolean);
      if (pids.length === 1 && pids[0] === String(child.pid)) {
        const ready = { ...record, status: 'listening', observedAt: new Date().toISOString() };
        save(directory + '/frontend-running.json', ready);
        save('tmp/redeploy-20261009/frontend-running.json', ready);
        console.log(JSON.stringify({ started: true, pid: child.pid, port: 3100, buildId, tradeProof: false }));
        return;
      }
      if (pids.length) throw Error('UNEXPECTED_FRONTEND_LISTENER_REQUIRES_REVIEW');
      try { process.kill(child.pid, 0); } catch { throw Error('FRONTEND_EXITED_SEE_PRIVATE_LOG'); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('FRONTEND_START_TIMEOUT_INSPECT_RECORDED_PID');
  } finally { fs.rmdirSync(lock); }
}
main().catch(error => {
  console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'FRONTEND_RESTART_FAILED');
  process.exitCode = 1;
});
