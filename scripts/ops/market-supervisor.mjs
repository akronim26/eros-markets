/** Persistent Monad testnet workers. No deployment, funding, key creation or journal reset. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { makerPolicy } from '../e2e/maker-maintenance-policy.mjs';
import { liquidationPolicy } from '../e2e/service-runtime-policy.mjs';
import { formatRunwayRow, gasRunwayConfig, launchShortfalls, readGasRunway, roleBudgets, RunwayAlerts } from './gas-runway.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(new URL('../../packages/pricefeed/package.json', import.meta.url));
const { createPublicClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function exitPolicy({ code, signal, text = '', restarts = 0 }) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let failure = lines.at(-1) ?? '';
  for (const line of [...lines].reverse()) {
    const error = line.match(/^(?:\w*Error):\s*(.+)/);
    if (error) { failure = error[1]; break; }
    try {
      const row = JSON.parse(line);
      const reason = row.stoppedFor ?? row.error ?? (row.stopped || row.fatal ? row.reason : undefined);
      if (typeof reason === 'string') { failure = reason; break; }
    } catch { /* Ordinary worker/stack output is not a structured failure. */ }
  }
  // Match error codes/phrases, not healthy JSON fields such as "nonce" or "budget".
  const fatalCode = /\b(?:[A-Z0-9]+_)*(?:NONCE|INTEGRITY|MISMATCH|NONCANONICAL|QUARANTINED|LOCKED|RETIRED|RECONCILIATION)(?:_[A-Z0-9]+)*\b/;
  if (code === 78 || fatalCode.test(failure) || /publication-budget-exhausted|TESTNET_RELAY_BUDGET_EXHAUSTED|cost.limit.exceeded|needs.test.mon|insufficient.funds|gas.wallet.below|Untracked sender nonce|nonce too low|nonce too high|WRONG_CHAIN|EEXIST|pending nonce requires reconciliation/i.test(failure))
    return { action: 'block', reason: 'operator-review-required' };
  if (restarts >= 5) return { action: 'block', reason: 'restart-limit' };
  if (code !== 0 && !signal && /timeout|timed.out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|HTTP_429|HTTP_5\d\d|rate.limit|fetch.failed|READ_FAILED|RPC_UNAVAILABLE|RPC_POOL_(?:UNAVAILABLE|BUSY|BLOCK_CHANGED)/i.test(failure))
    return { action: 'restart', delayMs: Math.min(60_000, 2_000 * 2 ** restarts), reason: 'transient-read-failure' };
  return { action: 'block', reason: 'unexpected-worker-exit' };
}

export function redact(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 8).sort((a,b) => b.length-a.length)) value = value.split(secret).join('[redacted]');
  return value.replace(/https?:\/\/[^\s"'<>]+/g, '[rpc-url]').replace(/(?:private[_ -]?key|authorization|api[_ -]?key)\s*[:=]\s*\S+/ig, '[credential-redacted]');
}

function ignored(relative, existing = true) {
  if (typeof relative !== 'string' || !relative.startsWith('tmp/') || relative.split('/').includes('..') || path.isAbsolute(relative)) throw Error('IGNORED_PRIVATE_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '-q', '--', relative], { cwd: root, stdio: 'pipe' });
  const resolved = path.resolve(root, relative);
  if (existing && !fs.existsSync(resolved)) throw Error('PRIVATE_FILE_MISSING');
  return resolved;
}

function atomic(file, value) {
  const fd = fs.openSync(file + '.tmp', 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(file + '.tmp', file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function prepare(configPath) {
  const config = read(ignored(configPath));
  if (config.schema !== 1 || !Array.isArray(config.markets) || !config.markets.length) throw Error('INVALID_SUPERVISOR_CONFIG');
  const stateDirectory = ignored(config.stateDirectory, false), rpcFile = ignored(config.rpcEnvFile);
  const rpc = parseEnv(fs.readFileSync(rpcFile, 'utf8'));
  if (!rpc.MONAD_TESTNET_RPC) throw Error('RPC_REQUIRED');
  const manifest = read(path.join(root, 'frontend/src/config/public-manifest.json'));
  if (manifest.chainId !== 10143 || manifest.scope !== 'testnet-read-only') throw Error('TESTNET_MANIFEST_REQUIRED');
  const secrets = Object.values(rpc), groups = [], allSenders = new Set(), engines = new Set(), names = new Set();
  const runwayConfig = gasRunwayConfig(config.gasRunway ?? {}), runwayGroups = [];
  for (const item of config.markets) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.name) || names.has(item.name)) throw Error('UNIQUE_MARKET_NAME_REQUIRED');
    names.add(item.name);
    if (typeof item.publicDirectory !== 'string' || !item.publicDirectory.startsWith('artifacts/deployments/') || item.publicDirectory.split('/').includes('..')) throw Error('PUBLIC_DEPLOYMENT_PATH_REQUIRED');
    ignored(item.privateDirectory);
    const services = `${item.publicDirectory}/services`, privateServices = `${item.privateDirectory}/services`;
    const ops = read(path.join(root, services, 'market-ops.json'));
    const publisher = read(path.join(root, services, 'pricefeed-config.json'));
    const prepared = read(path.join(root, item.privateDirectory, 'services-prepared.json'));
    const policy = read(path.join(root, services, 'pricefeed-policy.json'));
    if (prepared.publicDirectory !== item.publicDirectory) throw Error('PREPARED_PUBLIC_DIRECTORY_MISMATCH');
    for (const name of ['pricefeed-config.json', 'pricefeed-rules.json', 'pricefeed-policy.json', 'market-ops.json', 'oracle-deployments.json', 'engine-abi.json']) {
      const hash = createHash('sha256').update(fs.readFileSync(path.join(root, services, name))).digest('hex');
      if (prepared.hashes?.[name] !== hash) throw Error('PREPARED_SERVICE_PINS_CHANGED');
    }
    const roles = parseEnv(fs.readFileSync(path.join(root, item.privateDirectory, 'roles.env'), 'utf8'));
    secrets.push(...Object.values(roles));
    const market = manifest.markets.find(m => same(m.engine, ops.engine));
    if (!market || engines.has(market.engine.toLowerCase()) || ops.chainId !== 10143
      || !same(market.engine, prepared.engine) || !same(ops.listingHash, market.listingHash)
      || !same(ops.engineCodeHash, market.codehash) || !same(ops.marketId, market.marketId)
      || !same(ops.oracle, manifest.contracts.ResolutionOracle.address)
      || !same(ops.oracleCodeHash, manifest.contracts.ResolutionOracle.codehash)
      || !same(publisher.destination.chainId, 10143) || !same(publisher.destination.engineAddress, market.engine)
      || !same(publisher.destination.engineCodeHash, market.codehash) || !same(publisher.destination.marketId, market.marketId)
      || !same(publisher.destination.sourceId, market.sourceId)) throw Error('DEPLOYMENT_IDENTITY_MISMATCH');
    engines.add(market.engine.toLowerCase());
    for (const role of ['KEEPER', 'PUBLISHER', 'MAKER_BUY', 'MAKER_SELL', 'INDEX_SIGNER']) {
      const key = roles[`${role}_PRIVATE_KEY`];
      const account = privateKeyToAccount(key?.startsWith('0x') ? key : `0x${key}`);
      if (!same(account.address, prepared.roles[role]) || allSenders.has(account.address.toLowerCase())) throw Error('ROLE_IDENTITY_MISMATCH');
      allSenders.add(account.address.toLowerCase());
    }
    if (!same(ops.sender, prepared.roles.KEEPER) || !same(publisher.destination.signerAddress, prepared.roles.INDEX_SIGNER)
      || !same(policy.sender, prepared.roles.PUBLISHER)) throw Error('ROLE_BINDING_MISMATCH');
    for (const name of ['source.sqlite', 'packets.sqlite', 'signer.sqlite', 'transactions.sqlite', 'relay.sqlite'])
      if (!fs.existsSync(path.join(root, privateServices, 'pricefeed-journals', name))) throw Error('EXISTING_PUBLICATION_JOURNALS_REQUIRED');
    if (!fs.existsSync(path.join(root, privateServices, 'market-ops-journal.json')) || !fs.existsSync(path.join(root, item.privateDirectory, 'maker-journal.json'))) throw Error('EXISTING_OPERATOR_JOURNALS_REQUIRED');
    if (fs.existsSync(path.join(root, privateServices, 'retired.json'))) throw Error('RETIRED_PUBLICATION_SERVICE');
    const gas = String(item.keeperMaxGas ?? 3_000_000);
    if (!/^\d+$/.test(gas) || BigInt(gas) < 21_000n || BigInt(gas) > 30_000_000n) throw Error('INVALID_KEEPER_GAS_LIMIT');
    if (item.liquidationEnabled === true && !ops.gas?.liquidate) throw Error('MEASURED_LIQUIDATION_GAS_REQUIRED');
    if (item.liquidationEnabled !== undefined && typeof item.liquidationEnabled !== 'boolean') throw Error('INVALID_LIQUIDATION_SWITCH');
    const environment = { ...rpc, EROS_SERVICE_MODE: 'persistent', EROS_ROLE_FILE: `${item.privateDirectory}/roles.env`,
      EROS_PRICE_COORDINATION_DIR: `${item.privateDirectory}/coordination`, EROS_KEEPER_MAX_GAS: gas,
      ...(item.liquidationEnabled !== undefined ? { EROS_LIQUIDATION_ENABLED: String(item.liquidationEnabled) } : {}) };
    for (const [field, variable] of Object.entries({ targetLots: 'EROS_MAKER_TARGET_LOTS', maximumPositionLots: 'EROS_MAKER_MAX_POSITION_LOTS',
      maxActionsPerEpoch: 'EROS_MAKER_MAX_ACTIONS_PER_EPOCH', cooldownMs: 'EROS_MAKER_REQUOTE_COOLDOWN_MS',
      repriceTicks: 'EROS_MAKER_REPRICE_TICKS', captureWaitMs: 'EROS_MAKER_CAPTURE_WAIT_MS' })) {
      if (item.maker?.[field] !== undefined) environment[variable] = String(item.maker[field]);
    }
    if (item.liquidationIntervalMs !== undefined) environment.EROS_LIQUIDATION_INTERVAL_MS = String(item.liquidationIntervalMs);
    const maker = makerPolicy(environment); liquidationPolicy(environment, ops.gas?.liquidate);
    runwayGroups.push({ name: item.name, budgets: roleBudgets({ publisherRelay: policy.relay, keeperMaxGas: gas,
      samplePerpGas: ops.gas?.samplePerp, makerMaxActionsPerEpoch: maker.maxActionsPerEpoch }),
      addresses: Object.fromEntries(['PUBLISHER', 'KEEPER', 'MAKER_BUY', 'MAKER_SELL'].map(role => [role, prepared.roles[role]])) });
    if (config.sourceDnsServers) environment.EROS_SOURCE_DNS_SERVERS = config.sourceDnsServers;
    const node = config.nodeCommand ?? path.join(root, 'packages/pricefeed/node_modules/node/bin/node');
    const bun = config.bunCommand ?? 'bun';
    groups.push({ name: item.name, engine: market.engine, codehash: market.codehash, listingHash: market.listingHash,
      coordination: environment.EROS_PRICE_COORDINATION_DIR, environment, children: [
        { role: 'operations', command: bun, args: ['--no-env-file', 'scripts/e2e/market-services.ts', `${services}/market-ops.json`, `${privateServices}/market-ops-journal.json`, `${item.privateDirectory}/operations.jsonl`] },
        { role: 'publisher', command: node, args: ['scripts/e2e/pricefeed-watch.mjs', config.rpcEnvFile, services, privateServices, `${services}/pricefeed-policy.json`, `${item.privateDirectory}/publisher.jsonl`, '86400'] },
        { role: 'maker', command: node, args: ['scripts/e2e/makers.mjs', item.publicDirectory, item.privateDirectory, config.rpcEnvFile] },
      ] });
  }
  const client = createPublicClient({ transport: http(rpc.MONAD_TESTNET_RPC, { timeout: 10_000, retryCount: 0 }) });
  if (await client.getChainId() !== 10143) throw Error('WRONG_CHAIN');
  await sleep(400);
  const anchor = await client.getBlock({ blockTag: 'finalized' });
  if (Math.abs(Date.now()/1000 - Number(anchor.timestamp)) > 30) throw Error('STALE_CHAIN_HEAD');
  const abi = read(path.join(root, 'artifacts/risk/book-risk-engine-abi.json')).abi;
  for (const group of groups) {
    await sleep(400);
    const runtime = await client.call({ data: `0x73${group.engine.slice(2)}3f60005260206000f3`, blockNumber: anchor.number });
    if (!same(runtime.data, group.codehash)) throw Error('ENGINE_RUNTIME_MISMATCH');
    await sleep(400);
    if (!same(await client.readContract({ address: group.engine, abi, functionName: 'listingHash', blockNumber: anchor.number }), group.listingHash)) throw Error('LISTING_MISMATCH');
  }
  await sleep(400);
  if ((await client.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw Error('CANONICAL_ANCHOR_CHANGED');
  // Launch only with every operator wallet above its stopping threshold plus the configured runway.
  const runway = { client, groups: runwayGroups, config: runwayConfig };
  const report = await readGasRunway(runway);
  const shortfalls = launchShortfalls(report);
  if (shortfalls.length) throw Object.assign(Error('GAS_RUNWAY_INSUFFICIENT'), { details: shortfalls.map(formatRunwayRow) });
  return { stateDirectory, secrets, groups, block: String(anchor.number), blockHash: anchor.hash, runway,
    gasRunway: report.rows.map(formatRunwayRow) };
}

export async function supervise(prepared) {
  const { stateDirectory, secrets, groups, runway } = prepared;
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDirectory, 'supervisor.lock');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n'); fs.fsyncSync(lock);
  let stopping = false, heartbeat, runwayTimer;
  const children = new Map(), timers = new Set();
  const state = { pid: process.pid, status: 'starting', startedAt: new Date().toISOString(), stoppedAt: null, chainId: 10143,
    scope: 'Worker process status only; contract prices, fills and health require independent verification',
    groups: groups.map(g => ({ name: g.name, engine: g.engine, status: 'starting', children: g.children.map(c => ({ role: c.role, status: 'starting', pid: null, restarts: 0 })) })) };
  const save = () => atomic(path.join(stateDirectory, 'status.json'), { ...state, updatedAt: new Date().toISOString() });
  const event = data => { const line = JSON.stringify({ at: new Date().toISOString(), ...data }); fs.appendFileSync(path.join(stateDirectory, 'supervisor.jsonl'), line + '\n', { mode: 0o600 }); console.log(line); save(); };
  const stopGroup = (group, reason) => {
    if (group.status === 'blocked') return;
    group.status = 'blocked'; group.reason = reason;
    for (const child of group.children) children.get(`${group.name}:${child.role}`)?.kill('SIGTERM');
    event({ market: group.name, blocked: true, reason });
  };
  const shutdown = () => {
    stopping = true; state.status = 'stopping';
    for (const group of state.groups) if (group.status !== 'blocked') group.status = 'stopping';
    for (const timer of timers) clearTimeout(timer); timers.clear();
    for (const child of children.values()) child.kill('SIGTERM');
    save();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  function start(group, definition, childState) {
    if (stopping || group.status === 'blocked') return;
    const key = `${group.name}:${definition.role}`;
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const source = groups.find(g => g.name === group.name);
    const child = spawn(definition.command, definition.args, { cwd: root, env: { ...env, ...source.environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(key, child); childState.pid = child.pid ?? null; childState.status = 'running'; group.status = 'running';
    let tail = '', pending = '';
    const line = raw => {
      const clean = redact(raw, secrets).slice(0, 16_384); tail = (tail + '\n' + clean).slice(-32_768);
      fs.appendFileSync(path.join(stateDirectory, `${group.name}-${definition.role}.log`), clean + '\n', { mode: 0o600 });
      if (/publication-budget-exhausted|MONAD_SENDER_NEEDS_TEST_MON|KEEPER_NEEDS_TEST_MON|gas wallet below policy minimum/i.test(clean)) stopGroup(group, 'worker-budget-or-funding-blocked');
    };
    const output = buffer => { pending += buffer.toString(); let next; while ((next = pending.indexOf('\n')) >= 0) { line(pending.slice(0,next)); pending = pending.slice(next+1); } if (pending.length > 65_536) { line(pending); pending = ''; } };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.on('error', error => { line(error.code ?? 'CHILD_SPAWN_FAILED'); });
    child.on('close', (code, signal) => {
      if (pending) line(pending); children.delete(key); childState.pid = null; childState.exitCode = code; childState.signal = signal;
      if (stopping || group.status === 'blocked') { childState.status = 'stopped'; save(); return; }
      const decision = exitPolicy({ code, signal, text: tail, restarts: childState.restarts });
      if (decision.action === 'block') { childState.status = 'blocked'; stopGroup(group, decision.reason); return; }
      childState.restarts++; childState.status = 'backoff';
      event({ market: group.name, role: definition.role, restart: childState.restarts, delayMs: decision.delayMs });
      const timer = setTimeout(() => { timers.delete(timer); start(group, definition, childState); }, decision.delayMs); timers.add(timer);
    });
    event({ market: group.name, role: definition.role, started: true, pid: child.pid });
  }
  try {
    for (const group of state.groups) {
      const source = groups.find(g => g.name === group.name);
      fs.mkdirSync(path.join(root, source.coordination), { recursive: true, mode: 0o700 });
      for (let i = 0; i < source.children.length; i++) start(group, source.children[i], group.children[i]);
    }
    state.status = 'running'; save();
    heartbeat = setInterval(save, 5_000);
    if (runway) {
      // Alert while workers still have headroom; workers keep their own pre-signing stops.
      const alerts = new RunwayAlerts();
      let checking = false;
      const check = async () => {
        if (checking || stopping) return;
        checking = true;
        try {
          const report = await readGasRunway(runway);
          state.gasRunway = { block: String(report.block), rows: report.rows.map(formatRunwayRow) };
          for (const change of alerts.changes(report)) event({ gasRunwayAlert: change.level !== 'ok', ...change });
          save();
        } catch { event({ gasRunwayCheck: 'READ_FAILED' }); } finally { checking = false; }
      };
      runwayTimer = setInterval(check, runway.config.checkIntervalMs);
      await check();
    }
    while (children.size || timers.size) await sleep(500);
    if (!stopping && state.groups.some(g => g.status === 'blocked')) process.exitCode = 78;
  } finally {
    clearInterval(heartbeat); clearInterval(runwayTimer); shutdown();
    // No forced kill: workers must preserve/reconcile any signed transaction before exit.
    while (children.size) await sleep(500);
    for (const group of state.groups) if (group.status !== 'blocked') {
      group.status = 'stopped';
      for (const child of group.children) { child.status = 'stopped'; child.pid = null; }
    }
    state.status = state.groups.some(group => group.status === 'blocked') ? 'blocked' : 'stopped';
    state.stoppedAt = new Date().toISOString();
    save(); fs.closeSync(lock); fs.unlinkSync(lockPath);
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, config] = process.argv.slice(2);
    if (!['check', 'run'].includes(command) || !config) throw Error('USAGE_CHECK_OR_RUN_PRIVATE_CONFIG');
    const prepared = await prepare(config);
    console.log(JSON.stringify({ checked: true, block: prepared.block, markets: prepared.groups.map(g=>({name:g.name,engine:g.engine})), processes: prepared.groups.length*3, gasRunway: prepared.gasRunway }));
    if (command === 'run') await supervise(prepared);
  } catch (error) { console.error(JSON.stringify({ failed: true, reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'SUPERVISOR_FAILED_REVIEW_LOCAL_STATE', ...(error.details ? { shortfalls: error.details } : {}) })); process.exitCode = 1; }
}
