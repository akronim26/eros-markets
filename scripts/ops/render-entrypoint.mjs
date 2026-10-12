/**
 * Container entrypoint for the always-on market supervisor (Render Background Worker).
 * The persistent disk is mounted at <repo>/tmp. Secrets come from the host's secret files
 * (default /etc/secrets), never from the image or the hand-off bundle:
 *   rpc-pool.env                   -> config.rpcEnvFile
 *   <market>.roles.env             -> <privateDirectory>/roles.env
 *   <market>.keys.tgz.b64          -> <privateDirectory>/services/keys/ (base64 tar.gz)
 * Until `runner-handoff.mjs accept` has run on this disk, it waits instead of starting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ACCEPTED } from './runner-handoff.mjs';
import { containerPrivatePath } from './market-supervisor.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function place(source, target) {
  if (!fs.existsSync(source)) throw Error('SECRET_FILE_MISSING:' + path.basename(source));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
}

export function installSecrets({ repository = root, config, secrets = '/etc/secrets' }) {
  place(path.join(secrets, 'rpc-pool.env'), containerPrivatePath(config.rpcEnvFile, repository));
  for (const market of config.markets) {
    const dir = containerPrivatePath(market.privateDirectory, repository);
    place(path.join(secrets, `${market.name}.roles.env`), path.join(dir, 'roles.env'));
    const keys = path.join(dir, 'services', 'keys'), archive = path.join(secrets, `${market.name}.keys.tgz.b64`);
    if (!fs.existsSync(archive)) throw Error('SECRET_FILE_MISSING:' + path.basename(archive));
    fs.rmSync(keys, { recursive: true, force: true });
    fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
    const tgz = path.join(keys, '.keys.tgz');
    fs.writeFileSync(tgz, Buffer.from(fs.readFileSync(archive, 'utf8'), 'base64'), { mode: 0o600 });
    try { execFileSync('tar', ['-xzf', tgz, '-C', keys, '--no-same-owner']); } finally { fs.rmSync(tgz) }
    for (const name of fs.readdirSync(keys)) fs.chmodSync(path.join(keys, name), 0o600);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.env.EROS_CONTAINER_MODE = '1';
  const configPath = process.env.EROS_SUPERVISOR_CONFIG;
  try {
    if (!configPath) throw Error('EROS_SUPERVISOR_CONFIG_REQUIRED');
    const configFile = containerPrivatePath(configPath);
    for (;;) {
      const state = fs.existsSync(configFile) && containerPrivatePath(JSON.parse(fs.readFileSync(configFile, 'utf8')).stateDirectory);
      if (state && fs.existsSync(path.join(state, ACCEPTED))) break;
      console.log(JSON.stringify({ at: new Date().toISOString(), waiting: 'runner hand-off not accepted on this disk' }));
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
    installSecrets({ config: JSON.parse(fs.readFileSync(configFile, 'utf8')) });
    const child = spawn(process.execPath, ['scripts/ops/market-supervisor.mjs', 'run', configPath], { cwd: root, stdio: 'inherit', env: process.env });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(/^[A-Z_]+(:[\w.-]+)?$/.test(error.message) ? error.message : 'ENTRYPOINT_FAILED');
    process.exitCode = 1;
  }
}
