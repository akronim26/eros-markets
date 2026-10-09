/** Stage/apply verified fast-testnet manifests. No signing, policy API writes or service starts. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
process.chdir(root);
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { createPublicClient, http, parseAbi } = require('viem');
const files = ['public-manifest.json', 'archived-deployments.json', 'market-metadata.json', 'risk-calibrations.json'];
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const saveText = (p, value) => {
  fs.writeFileSync(p + '.tmp', value, { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
};
const save = (p, value) => saveText(p, JSON.stringify(value, null, 2) + '\n');
const snapshot = () => Object.fromEntries(files.map(f => [f, read('frontend/src/config/' + f)]));
const fingerprints = () => Object.fromEntries(files.map(f => [f, hash('frontend/src/config/' + f)]));
const exactWindows = { indexSeconds: 60, perpSeconds: 60, basisSeconds: 180, carryLimitSeconds: 30 };
const liveConfig = 'tmp/redeploy-audit-20261007/indexer/config.yaml';
const liveEnv = 'tmp/redeploy-audit-20261007/indexer/indexer.env';
const liveIdentity = () => ({ configSha256: hash(liveConfig), environmentSha256: hash(liveEnv) });
const deploymentHashes = dirs => Object.fromEntries(dirs.flatMap(dir =>
  ['market-verification.json', 'source.json', 'calibration.json'].map(file => [dir + '/' + file, hash(dir + '/' + file)])));

function directory(value, parent) {
  if (!value || path.dirname(value) !== parent || fs.realpathSync(value) !== path.resolve(root, value))
    throw Error('DIRECT_EXISTING_DIRECTORY_REQUIRED');
  return value;
}

function assertArchives(before, after) {
  const identities = selections => selections.flatMap(m => m.markets.map(engine => ({
    engine: engine.engine.toLowerCase(), market: engine, contracts: m.contracts,
  }))).sort((a, b) => a.engine.localeCompare(b.engine));
  if (!equal(identities([before['public-manifest.json'], ...before['archived-deployments.json']]),
    identities(after['archived-deployments.json']))) throw Error('ARCHIVED_CUSTODY_CHANGED');
}

function delegationInventory() {
  const env = { ...process.env, ...parseEnv(fs.readFileSync('frontend/.env.local', 'utf8')) };
  return Object.fromEntries(['trade', 'protect'].map(mode => {
    const upper = mode.toUpperCase();
    const fields = ['NEXT_PUBLIC_PRIVY_APP_ID', 'PRIVY_APP_SECRET', `PRIVY_${upper}_SIGNER_ID`,
      `PRIVY_POLICY_${upper}_ID`, mode === 'trade' ? 'PRIVY_AUTHORIZATION_PRIVATE_KEY' : 'PRIVY_PROTECT_AUTHORIZATION_PRIVATE_KEY'];
    const present = Object.fromEntries(fields.map(k => [k, !!env[k]]));
    return [mode, { configured: fields.every(k => present[k]), present }];
  }));
}

async function childStage(dirs, rpc) {
  await new Promise((resolve, reject) => {
    const p = spawn('bun', ['--no-env-file', 'scripts/e2e/select-live-markets.ts', ...dirs], {
      cwd: root, env: { ...process.env, MONAD_TESTNET_RPC: rpc }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The existing selector may surface transport errors. Keep endpoint-bearing output private.
    p.stdout.resume(); p.stderr.resume();
    p.once('error', () => reject(Error('SELECTION_START_FAILED')));
    p.once('exit', code => code === 0 ? resolve() : reject(Error('SELECTION_STAGE_FAILED')));
  });
}

async function verifyWindows(dirs, rpc) {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 10000 }) });
  if (await client.getChainId() !== 10143) throw Error('WRONG_CHAIN');
  const anchor = await client.getBlock({ blockTag: 'finalized' });
  const abi = parseAbi(['function pricingWindows() view returns(uint64,uint64,uint64,uint64)',
    'function factory() view returns(address)']);
  const proofs = [];
  for (const dir of dirs) {
    const report = read(dir + '/market-verification.json');
    if (report.passed !== true || report.publicTransactions !== 7 || !equal(report.pricingWindows, exactWindows)
      || report.manifest.chainId !== 10143 || report.manifest.markets.length !== 1) throw Error('VERIFIED_FAST_MARKET_REQUIRED');
    const manifest = report.manifest, market = manifest.markets[0];
    if ((await client.getBlock({ blockNumber: BigInt(manifest.verifiedAt.blockNumber) })).hash !== manifest.verifiedAt.blockHash)
      throw Error('MARKET_VERIFICATION_REORGED');
    const windows = await client.readContract({ address: market.engine, abi, functionName: 'pricingWindows', blockNumber: anchor.number });
    const runtime = await client.call({ data: `0x73${market.engine.slice(2)}3f60005260206000f3`, blockNumber: anchor.number });
    const factory = await client.readContract({ address: manifest.contracts.MarketRegistry.address, abi,
      functionName: 'factory', blockNumber: anchor.number });
    if (windows.map(String).join(',') !== '60,60,180,30' || !same(runtime.data, market.codehash)
      || !same(factory, manifest.contracts.MarketFactory.address)) throw Error('CURRENT_FAST_PROFILE_BINDING_MISMATCH');
    proofs.push({ engine: market.engine, codehash: market.codehash, marketId: market.marketId,
      sourceId: market.sourceId, listingHash: market.listingHash, pricingWindows: exactWindows });
  }
  if ((await client.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw Error('PROFILE_ANCHOR_REORGED');
  return { schema: 'eros-testnet-pricing-profile/1', chainId: 10143,
    verifiedAt: { blockNumber: anchor.number.toString(), blockHash: anchor.hash }, markets: proofs,
    epochPromotion: 'unchanged-hourly', riskParameters: 'unchanged', experimentalTestnetTiming: true };
}

function assertFrontendStopped() {
  try {
    const pids = execFileSync('lsof', ['-nP', '-iTCP:3100', '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (pids.trim()) throw Error('STOP_FRONTEND_PORT_3100_BEFORE_APPLY');
  } catch (error) { if (error.status !== 1) throw error; }
}

async function main() {
  const [command, stateDirectory, btc, eth, ...extra] = process.argv.slice(2);
  if (!['stage', 'apply', 'installed'].includes(command) || extra.length || !stateDirectory?.startsWith('tmp/')
    || stateDirectory.includes('..') || stateDirectory.endsWith('/')) throw Error('EXPECTED_STAGE_APPLY_OR_INSTALLED_AND_PRIVATE_STATE_DIRECTORY_AND_TWO_PUBLIC_DIRECTORIES');
  const dirs = [directory(btc, 'artifacts/deployments'), directory(eth, 'artifacts/deployments')];
  if (dirs[0] === dirs[1]) throw Error('DISTINCT_MARKETS_REQUIRED');
  const rpc = parseEnv(fs.readFileSync('tmp/redeploy-20261009/rpc-pool.env', 'utf8')).MONAD_TESTNET_RPC;
  if (!rpc) throw Error('PRIVATE_READ_RPC_REQUIRED');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(stateDirectory) !== path.resolve(root, stateDirectory)) throw Error('DIRECT_STATE_DIRECTORY_REQUIRED');
  const lock = stateDirectory + '/migration.lock';
  fs.mkdirSync(lock); // Never remove someone else's lock, including after an interrupted process.
  try {
    const statePath = stateDirectory + '/migration-stage.json';
    if (command === 'stage') {
      if (fs.existsSync(statePath)) throw Error('EXISTING_STAGE_REQUIRES_REVIEW');
      const before = snapshot(), beforeHashes = fingerprints(), liveIndexer = liveIdentity(), publicHashes = deploymentHashes(dirs);
      const beforeText = Object.fromEntries(files.map(f => [f, fs.readFileSync('frontend/src/config/' + f, 'utf8')]));
      const profile = await verifyWindows(dirs, rpc);
      const reports = dirs.map(d => read(d + '/market-verification.json'));
      for (const [i, dir] of dirs.entries()) {
        const source = read(dir + '/source.json'), calibration = read(dir + '/calibration.json');
        if (String(source.config?.mapping?.externalMarketId) !== ['5238640', '5286464'][i]
          || source.marketId !== reports[i].manifest.markets[0].marketId
          || source.sourceId !== reports[i].manifest.markets[0].sourceId
          || !same(calibration.profileHash, reports[i].profileHash)) throw Error('APPROVED_SOURCE_OR_CALIBRATION_MISMATCH');
      }
      const nextContracts = reports[0].manifest.contracts, previousContracts = before['public-manifest.json'].contracts;
      if (same(nextContracts.MarketFactory.address, previousContracts.MarketFactory.address)
        || same(nextContracts.CollateralVault.address, previousContracts.CollateralVault.address)) throw Error('REPLACEMENT_FACTORY_AND_VAULT_REQUIRED');
      for (const name of ['MarketRegistry', 'ResolutionOracle', 'CollateralToken'])
        if (!equal(nextContracts[name], previousContracts[name])) throw Error('PRESERVED_SHARED_DEPENDENCY_REQUIRED');
      await childStage(dirs, rpc);
      const output = dirs[0] + '/frontend-selection';
      const selection = Object.fromEntries(files.map(f => [f, read(output + '/' + f)]));
      assertArchives(before, selection);
      if (!equal(beforeHashes, fingerprints()) || !equal(liveIndexer, liveIdentity())
        || !equal(publicHashes, deploymentHashes(dirs))) throw Error('LIVE_FILES_CHANGED_DURING_STAGE');
      save(output + '/pricing-profile.json', profile);
      const state = { schema: 'eros-fast-public-migration/1', status: 'staged', at: new Date().toISOString(), dirs,
        output, before, beforeText, beforeHashes, liveIndexer, publicHashes, profile, delegation: delegationInventory(),
        stagedHashes: Object.fromEntries(files.map(f => [f, hash(output + '/' + f)])) };
      save(statePath, state);
      console.log(JSON.stringify({ staged: true, applied: false, output, statePath, activeMarkets: 2,
        archivedMarkets: selection['archived-deployments.json'].reduce((n, m) => n + m.markets.length, 0),
        delegation: Object.fromEntries(Object.entries(state.delegation).map(([mode, value]) => [mode, value.configured])) }));
      return;
    }
    const state = read(statePath);
    if (state.schema !== 'eros-fast-public-migration/1' || !equal(state.dirs, dirs)
      || !equal(state.liveIndexer, liveIdentity()) || !equal(state.publicHashes, deploymentHashes(dirs)))
      throw Error('MIGRATION_OR_LIVE_INDEXER_CHANGED');
    const selection = Object.fromEntries(files.map(f => {
      if (hash(state.output + '/' + f) !== state.stagedHashes[f]) throw Error('STAGED_FILE_CHANGED');
      return [f, read(state.output + '/' + f)];
    }));
    assertArchives(state.before, selection);
    if (command === 'apply') {
      if (state.status !== 'staged' || !equal(state.beforeHashes, fingerprints())) throw Error('CURRENT_SELECTION_CHANGED_REVIEW_REQUIRED');
      assertFrontendStopped();
      await verifyWindows(dirs, rpc);
      assertFrontendStopped();
      if (!equal(state.beforeHashes, fingerprints()) || !equal(state.liveIndexer, liveIdentity())
        || !equal(state.publicHashes, deploymentHashes(dirs))) throw Error('INPUT_CHANGED_DURING_APPLY_PREFLIGHT');
      save(statePath, { ...state, status: 'applying' });
      try {
        for (const [f, value] of Object.entries(selection)) save('frontend/src/config/' + f, value);
        if (!equal(state.liveIndexer, liveIdentity())) throw Error('LIVE_INDEXER_CHANGED_DURING_APPLY');
        save(statePath, { ...state, status: 'applied', appliedAt: new Date().toISOString(), installedHashes: fingerprints() });
      } catch (error) {
        for (const [f, value] of Object.entries(state.beforeText)) saveText('frontend/src/config/' + f, value);
        save(statePath, { ...state, status: 'rolled-back', rolledBackAt: new Date().toISOString() });
        throw error;
      }
      console.log(JSON.stringify({ applied: true, servicesRestarted: false, liveIndexerUnchanged: true,
        next: 'Sync only public indexer configs, review Privy configuration, build/restart frontend; preserve live indexer database.' }));
      return;
    }
    if (state.status !== 'applied' || !equal(state.installedHashes, fingerprints())) throw Error('INSTALLED_SELECTION_CHANGED');
    console.log(JSON.stringify({ installed: true, liveIndexerUnchanged: true, activeMarkets: 2,
      archivedCustodyPreserved: true, tradeProof: false, note: 'File consistency only; no user trade or balance movement performed.' }));
  } finally { fs.rmdirSync(lock); }
}
main().catch(error => {
  console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PUBLIC_MIGRATION_FAILED');
  process.exitCode = 1;
});
