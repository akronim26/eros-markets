/**
 * Native market kinds for the market supervisor. A market entry with `kind` other than the default
 * Polymarket perp is prepared here: its workers, their environment, the operator addresses and gas
 * budgets the runway check and auto top-up use, and the exit policy for its workers.
 *
 *   native-spot       maker, daily trader and oracle lifecycle of a Kuru spot prediction market. The
 *                     lifecycle also resolves `linkedMarketIds` (perps on the same event and feed).
 *   native-spot-perp  INDEX publisher (another market's Kuru YES book) and keeper/perp maker.
 *
 * Each native market has a git-ignored `privateDirectory` holding its secret `ops.env` (`envFile`,
 * installed from the host's secret store) and the durable maker/trader state the hand-off bundles.
 *
 * Native workers hold no journals: every transaction takes its nonce from the chain, so a restart is
 * always safe. Configuration and identity failures block; anything else restarts with backoff.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { MON } from './gas-runway.mjs';

export const NATIVE_KINDS = ['native-spot', 'native-spot-perp'];
/** Durable non-secret files a native market carries to a new host (everything else there is secret or disposable). */
export const NATIVE_STATE_FILE = /(^|\/)(maker|trader)-state\.json$/;
export const NATIVE_ROLES = ['MAKER', 'TRADER', 'LIFECYCLE', 'INDEX_SIGNER', 'PERP_MAKER'];

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pinned = (value, name) => { if (typeof value !== 'string' || !value) throw Error(`NATIVE_ENV_${name}_REQUIRED`); return value; };
// Paths from a private env file stay inside the repository (relative, no parent segments).
const repoPath = (root, value, name) => {
  const v = pinned(value, name);
  if (path.isAbsolute(v) || v.split('/').includes('..')) throw Error(`NATIVE_PATH_${name}_INVALID`);
  if (!fs.existsSync(path.join(root, v))) throw Error(`NATIVE_PATH_${name}_MISSING`);
  return v;
};

/** Gas a role may spend per hour (gas units, not wei) and the balance it stops at. */
function budget(role, stopMon, gasPerHour, overrides = {}) {
  const gas = overrides[role] ?? gasPerHour;
  if (!Number.isSafeInteger(gas) || gas <= 0) throw Error('INVALID_NATIVE_GAS_PER_HOUR');
  return { role, stopWei: BigInt(Math.round(stopMon * 1000)) * MON / 1000n, gasPerHour: BigInt(gas) };
}

const CONFIG_FAILURE = /\b(?:BAD_ARGUMENTS|BAD_MARKET_IDS|MISSING_[A-Z_]+|LISTING_PIN_MISMATCH_\w+|RULES_CONFIG_MISMATCH_\w+|SOURCE_NOT_CONFIGURED_FOR_SIGNER|PERP_NOT_LISTED_IN_REGISTRY|INDEX_VAULT_RULES_MISMATCH|OPEN_TICK_OUT_OF_RANGE|DEVELOPMENT_CHAIN_ONLY|UNSUPPORTED_RULES_POLICY|BAD_RULES_\w+)\b/;
export const NATIVE_GAS_LOW = /insufficient funds|keeper balance [\d.]+ MON < [\d.]+: stopping/i;

/** Native worker exits: done on success, block on configuration or gas, otherwise restart (never give up). */
export function nativeExitPolicy({ code, signal, text = '', restarts = 0 }) {
  if (code === 0 && !signal) return { action: 'done', reason: 'finished' };
  const tail = text.slice(-16_384);
  if (CONFIG_FAILURE.test(tail)) return { action: 'block', reason: 'operator-review-required' };
  if (NATIVE_GAS_LOW.test(tail)) return { action: 'block', reason: 'operator-gas-low' };
  // Nonces come from the chain on every send, so restarting cannot double-sign. Back off to 5 minutes.
  return { action: 'restart', delayMs: Math.min(300_000, 5_000 * 2 ** Math.min(restarts, 6)), reason: 'native-worker-exit' };
}

function keyAddress(privateKeyToAccount, key, name) {
  const v = pinned(key, name);
  return privateKeyToAccount(v.startsWith('0x') ? v : `0x${v}`).address;
}

/**
 * Prepare one native market entry. `context` supplies root, the frontend manifest, the private-path
 * check, the account helper, the node/bun commands and the sender set shared by every market.
 */
export function prepareNativeMarket(item, { root, manifest, ignored, privateKeyToAccount, node, bun, allSenders }) {
  if (!NATIVE_KINDS.includes(item.kind)) throw Error('UNKNOWN_MARKET_KIND');
  ignored(item.privateDirectory);
  const envFile = item.envFile ?? `${item.privateDirectory}/ops.env`;
  if (!envFile.startsWith(`${item.privateDirectory}/`) || envFile.split('/').includes('..')) throw Error('NATIVE_ENV_FILE_OUTSIDE_PRIVATE_DIRECTORY');
  ignored(envFile);
  const mode = fs.statSync(path.join(root, envFile)).mode & 0o777;
  if (mode & 0o077) throw Error('NATIVE_ENV_FILE_MODE_600_REQUIRED');
  const env = parseEnv(fs.readFileSync(path.join(root, envFile), 'utf8'));
  const secrets = Object.values(env);
  const roles = {};
  const claim = (role, key, name) => {
    const address = keyAddress(privateKeyToAccount, key, name);
    if (allSenders.has(address.toLowerCase())) throw Error('ROLE_IDENTITY_MISMATCH');
    allSenders.add(address.toLowerCase()); roles[role] = address;
  };
  const overrides = item.gasPerHour ?? {};

  if (item.kind === 'native-spot') {
    const deploymentPath = repoPath(root, env.D, 'D');
    const feedPath = repoPath(root, env.FEED, 'FEED');
    const d = read(path.join(root, deploymentPath));
    const market = manifest.markets.find(m => same(m.marketId, d.marketId));
    const bindings = read(path.join(root, 'frontend/src/config/native-markets.json'));
    const binding = market && bindings[Object.keys(bindings).find(k => same(k, market.engine))];
    if (!market || !binding?.spotOnly || !same(binding.vault, d.outcomeVault) || !same(binding.yesBook, d.yesBook)
      || !same(binding.noBook, d.noBook) || !same(binding.collateral, d.collateral)) throw Error('DEPLOYMENT_IDENTITY_MISMATCH');
    const linked = item.linkedMarketIds ?? [];
    if (!Array.isArray(linked) || linked.some(id => !manifest.markets.some(m => same(m.marketId, id)) || same(id, d.marketId)))
      throw Error('LINKED_MARKET_NOT_IN_MANIFEST');
    claim('MAKER', env.MAKER_KEY, 'MAKER_KEY'); claim('TRADER', env.TRADER_KEY, 'TRADER_KEY'); claim('LIFECYCLE', env.KEEPER_KEY, 'KEEPER_KEY');
    const shared = { RPC: pinned(env.RPC, 'RPC'), D: deploymentPath };
    // Every non-secret setting (cadences, sizes, ticks) reaches every worker; each key reaches only its role.
    const knobs = Object.fromEntries(Object.entries(env).filter(([k]) => !/_KEY$|_KEY_VALUE$|^(RPC|D|FEED|MARKET_IDS)$/.test(k)));
    const script = name => ['--no-env-file', `packages/pricefeed/scripts/native-spot/${name}`];
    return {
      secrets,
      group: { name: item.name, engine: market.engine, codehash: market.codehash, listingHash: market.listingHash, kind: item.kind,
        alwaysAwake: true, exitPolicy: nativeExitPolicy, gasLow: NATIVE_GAS_LOW, environment: {},
        children: [
          { role: 'maker', command: bun, args: script('maker.ts'),
            environment: { ...shared, ...knobs, MAKER_KEY: env.MAKER_KEY, STATE: `${item.privateDirectory}/maker-state.json` } },
          { role: 'trader', command: bun, args: script('daily-trader.ts'),
            environment: { ...shared, ...knobs, TRADER_KEY: env.TRADER_KEY, STATE: `${item.privateDirectory}/trader-state.json` } },
          { role: 'lifecycle', command: bun, args: script('lifecycle.ts'), environment: { ...shared, ...knobs, FEED: feedPath, KEEPER_KEY: env.KEEPER_KEY,
            SPORTSDATA_API_KEY_VALUE: pinned(env.SPORTSDATA_API_KEY_VALUE, 'SPORTSDATA_API_KEY_VALUE'), MARKET_IDS: linked.join(',') } },
        ] },
      runwayGroup: { name: item.name, addresses: roles, budgets: [
        // Maker: cancel + bid + ask per side per re-quote, about a dozen re-quotes an hour at most.
        budget('MAKER', 0.5, 40_000_000, overrides), budget('TRADER', 0.2, 2_000_000, overrides), budget('LIFECYCLE', 0.2, 2_000_000, overrides)] },
    };
  }

  // native-spot-perp
  const deploymentPath = repoPath(root, env.NATIVE_DEPLOYMENT, 'NATIVE_DEPLOYMENT');
  const rulesPath = repoPath(root, env.NATIVE_RULES, 'NATIVE_RULES');
  const engine = pinned(env.NATIVE_ENGINE, 'NATIVE_ENGINE');
  const market = manifest.markets.find(m => same(m.engine, engine));
  const rules = read(path.join(root, rulesPath));
  if (!market || !same(market.marketId, rules.marketId) || !same(market.sourceId, rules.sourceId)) throw Error('DEPLOYMENT_IDENTITY_MISMATCH');
  const rpc = pinned(env.MONAD_RPC_URL, 'MONAD_RPC_URL');
  // The same read-only verification `ops.sh check` runs: spot vault, books, perp listing and source pins.
  let verified;
  try {
    verified = JSON.parse(execFileSync(node, ['packages/pricefeed/dist/scripts/native-verify.js', rpc, deploymentPath, rulesPath, engine],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).split('\n').filter(Boolean).slice(-6).join('\n').replace(/^[^{]*/, ''));
  } catch { throw Error('NATIVE_VERIFICATION_FAILED'); }
  if (verified.failed !== 0 || !same(verified.engine, engine)) throw Error('NATIVE_VERIFICATION_FAILED');
  claim('INDEX_SIGNER', env.NATIVE_OBSERVER_PRIVATE_KEY, 'NATIVE_OBSERVER_PRIVATE_KEY');
  claim('KEEPER', env.NATIVE_KEEPER_PRIVATE_KEY, 'NATIVE_KEEPER_PRIVATE_KEY');
  claim('PERP_MAKER', env.NATIVE_PERP_MAKER_PRIVATE_KEY, 'NATIVE_PERP_MAKER_PRIVATE_KEY');
  const publishMs = Number(env.PUBLISH_MS ?? 60_000), every = Number(env.KEEPER_EVERY ?? 90);
  if (!Number.isInteger(publishMs) || publishMs < 5_000 || !Number.isInteger(every) || every < 10) throw Error('INVALID_NATIVE_CADENCE');
  const fallbacks = env.MONAD_READ_FALLBACK_URLS ?? '';
  return {
    secrets,
    group: { name: item.name, engine: market.engine, codehash: market.codehash, listingHash: market.listingHash, kind: item.kind,
      alwaysAwake: true, exitPolicy: nativeExitPolicy, gasLow: NATIVE_GAS_LOW, environment: {},
      children: [
        { role: 'publisher', command: node, args: ['packages/pricefeed/dist/scripts/native-publish.js', 'env', rulesPath, engine, '1000000', String(publishMs), 'finalized'],
          environment: { NATIVE_OBSERVER_KEY: env.NATIVE_OBSERVER_PRIVATE_KEY, NATIVE_RPC: rpc, NATIVE_RPC_FALLBACKS: fallbacks } },
        { role: 'keeper', command: 'bash', args: ['scripts/native-market/keeper-daemon.sh'],
          environment: { R: rpc, RF: fallbacks, ENG: engine, KEEPER_KEY: env.NATIVE_KEEPER_PRIVATE_KEY,
            PERP_MAKER_KEY: env.NATIVE_PERP_MAKER_PRIVATE_KEY, EVERY: String(every) } },
      ] },
    runwayGroup: { name: item.name, addresses: roles, budgets: [
      // Measured on Monad testnet: ~250k gas per INDEX publish, ~750k per keeper loop (sample + upkeep).
      budget('INDEX_SIGNER', 0.5, Math.ceil(3_600_000 / publishMs) * 300_000, overrides),
      budget('KEEPER', 2, Math.ceil(3_600 / every) * 750_000, overrides),
      budget('PERP_MAKER', 0.5, 24_000_000, overrides)] },
  };
}
