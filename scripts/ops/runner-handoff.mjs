/**
 * Move the market supervisor from this host to an always-on host without ever having two
 * runners. Two runners would sign with the same nonces from the same journals.
 *
 *   pack    (old host)  refuses unless the supervisor is stopped, no worker or lock remains and
 *                       every journal is readable; writes the bundle and its SHA-256 list, then
 *                       a `handed-off.json` marker that makes the old supervisor refuse to start.
 *   accept  (new host)  refuses unless every bundled file is present with its exact hash and no
 *                       different journal already exists; writes `handoff-accepted.json`.
 *
 * Secrets never enter the bundle: `roles.env`, `services/keys/`, native `ops.env` files and the RPC
 * env file come from the new host's secret store. A native market (`kind` native-*) contributes only
 * its maker/trader state files. Read-only with respect to the chain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NATIVE_STATE_FILE } from './market-kinds.mjs';

export const HANDED_OFF = 'handed-off.json';
export const ACCEPTED = 'handoff-accepted.json';
const SECRET = rel => /(^|\/)roles\.env$/.test(rel) || /(^|\/)services\/keys(\/|$)/.test(rel) || /\.env$/.test(rel);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const under = (root, rel) => {
  if (typeof rel !== 'string' || !rel.startsWith('tmp/') || rel.split('/').includes('..') || path.isAbsolute(rel)) throw Error('PRIVATE_TMP_PATH_REQUIRED');
  return path.resolve(root, rel);
};

function walk(root, rel, out = []) {
  const abs = path.resolve(root, rel);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = rel + '/' + entry.name;
    if (SECRET(child)) continue;
    if (entry.isSymbolicLink()) throw Error('SYMLINK_IN_PRIVATE_DIRECTORY');
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

const native = market => (market.kind ?? 'polymarket-perp') !== 'polymarket-perp';
/** Files a market carries to the new host: a Polymarket perp's journals, or a native market's state. */
const marketFiles = (root, market) => native(market)
  ? (fs.existsSync(path.resolve(root, market.privateDirectory)) ? walk(root, market.privateDirectory).filter(rel => NATIVE_STATE_FILE.test(rel)) : [])
  : walk(root, market.privateDirectory);

const defaultProcesses = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });

/** Throws unless the supervisor described by `config` is cleanly stopped on this host. */
export function assertStopped({ root, config, processes = defaultProcesses }) {
  const state = under(root, config.stateDirectory);
  if (fs.existsSync(path.join(state, 'supervisor.lock'))) throw Error('SUPERVISOR_LOCK_PRESENT');
  const statusFile = path.join(state, 'status.json');
  if (fs.existsSync(statusFile)) {
    const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (!['stopped', 'blocked'].includes(s.status) || s.groups?.some(g => g.children?.some(c => c.pid !== null)))
      throw Error('SUPERVISOR_NOT_STOPPED');
  }
  const dirs = config.markets.map(m => m.privateDirectory);
  for (const line of processes().split('\n')) {
    if (/scripts\/(e2e\/(pricefeed-watch\.mjs|market-services\.ts|makers\.mjs)|ops\/market-supervisor\.mjs)/.test(line)
      && (line.includes('market-supervisor.mjs') || dirs.some(d => line.includes(d)))) throw Error('WORKER_PROCESS_PRESENT');
    // Native workers carry no market directory on their command line: any live one blocks a hand-off.
    if (/native-spot\/(maker|daily-trader|lifecycle)\.ts|native-publish\.js|native-market\/keeper-daemon\.sh/.test(line)) throw Error('WORKER_PROCESS_PRESENT');
  }
  for (const m of config.markets) if (!native(m)) for (const rel of walk(root, m.privateDirectory)) if (rel.endsWith('.lock')) throw Error('JOURNAL_LOCK_PRESENT');
}

export function pack({ root, configPath, bundlePath, processes, now = () => new Date().toISOString() }) {
  const config = JSON.parse(fs.readFileSync(under(root, configPath), 'utf8'));
  const state = under(root, config.stateDirectory);
  if (fs.existsSync(path.join(state, HANDED_OFF))) throw Error('ALREADY_HANDED_OFF');
  assertStopped({ root, config, processes });
  const files = [configPath, ...config.markets.flatMap(m => marketFiles(root, m))];
  for (const rel of files) if (SECRET(rel)) throw Error('SECRET_IN_BUNDLE');
  const manifest = { schema: 'eros-runner-handoff/1', packedAt: now(), configPath,
    files: Object.fromEntries(files.map(rel => [rel, sha(path.resolve(root, rel))])) };
  const manifestRel = path.posix.join(path.posix.dirname(configPath), 'handoff-manifest.json');
  fs.writeFileSync(path.resolve(root, manifestRel), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  // COPYFILE_DISABLE stops macOS tar adding AppleDouble `._*` files, which accept rejects as unknown journals.
  execFileSync('tar', ['-czf', bundlePath, '-C', root, manifestRel, ...files], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  // Fence this host before anything else can start: the old supervisor refuses from here on.
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, HANDED_OFF), JSON.stringify({ at: manifest.packedAt, bundle: path.basename(bundlePath),
    files: files.length }, null, 2) + '\n', { mode: 0o600 });
  return { manifestRel, files: files.length };
}

/** On the new host, after extracting the bundle into the repository root (disk mounted at tmp/). */
export function accept({ root, manifestRel, now = () => new Date().toISOString() }) {
  const manifest = JSON.parse(fs.readFileSync(under(root, manifestRel), 'utf8'));
  if (manifest.schema !== 'eros-runner-handoff/1') throw Error('HANDOFF_MANIFEST_REQUIRED');
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const file = under(root, rel);
    if (!fs.existsSync(file)) throw Error('HANDOFF_FILE_MISSING');
    if (sha(file) !== hash) throw Error('HANDOFF_FILE_CHANGED');
  }
  // Workers refuse journal directories other users can read. Extraction keeps the old host's owner
  // and creates parent directories with the default umask, so make every bundled path private here.
  const tmpRoot = path.resolve(root, 'tmp');
  const own = target => { if (process.getuid) fs.chownSync(target, process.getuid(), process.getgid()); };
  for (const rel of Object.keys(manifest.files)) {
    const file = under(root, rel);
    own(file); fs.chmodSync(file, 0o600);
    for (let dir = path.dirname(file); dir.startsWith(tmpRoot + path.sep); dir = path.dirname(dir)) { own(dir); fs.chmodSync(dir, 0o700); }
  }
  const config = JSON.parse(fs.readFileSync(under(root, manifest.configPath), 'utf8'));
  // A journal written on this host after an earlier hand-off must never be overwritten silently.
  const known = new Set(Object.keys(manifest.files));
  for (const m of config.markets) for (const rel of marketFiles(root, m))
    if ((native(m) || /journal|\.sqlite/.test(rel)) && !known.has(rel)) throw Error('UNEXPECTED_JOURNAL_ON_NEW_HOST');
  const state = under(root, config.stateDirectory);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(state, HANDED_OFF))) throw Error('HANDED_OFF_STATE_COPIED');
  fs.writeFileSync(path.join(state, ACCEPTED), JSON.stringify({ at: now(), packedAt: manifest.packedAt,
    files: Object.keys(manifest.files).length }, null, 2) + '\n', { mode: 0o600 });
  return { accepted: true, files: Object.keys(manifest.files).length };
}

/** Called by the supervisor before it takes its lock. */
export function assertRunnerAllowed({ stateDirectory, containerMode }) {
  if (fs.existsSync(path.join(stateDirectory, HANDED_OFF))) throw Error('RUNNER_HANDED_OFF');
  if (containerMode && !fs.existsSync(path.join(stateDirectory, ACCEPTED))) throw Error('HANDOFF_NOT_ACCEPTED');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  try {
    const [command, a, b] = process.argv.slice(2);
    if (command === 'pack' && a && b) console.log(JSON.stringify({ packed: true, ...pack({ root, configPath: a, bundlePath: path.resolve(b) }) }));
    else if (command === 'accept' && a) console.log(JSON.stringify(accept({ root, manifestRel: a })));
    else throw Error('USAGE_PACK_CONFIG_BUNDLE_OR_ACCEPT_MANIFEST');
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'HANDOFF_FAILED'); process.exitCode = 1; }
}
