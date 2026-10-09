/** Isolated read-only drill; injects no failures into running workers or writer transports. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createReadPool, readPoolEndpoints } from '../../packages/pricefeed/dist/src/read-pool.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [rpcFile, evidenceFile] = process.argv.slice(2);
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance']);
let id = 0;
function privatePath(relative) {
  if (!relative?.startsWith('tmp/') || relative.split('/').includes('..') || path.isAbsolute(relative))
    throw Error('IGNORED_PRIVATE_PATH_REQUIRED');
  execFileSync('git', ['check-ignore', '-q', '--', relative], { cwd: root, stdio: 'ignore' });
  return path.join(root, relative);
}
async function rpc(url, request) {
  if (!allowed.has(request.method)) throw Error('READ_ONLY_METHOD_REQUIRED');
  const requestId = ++id;
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, ...request, params: request.params ?? [] }) });
  if (!response.ok) throw Object.assign(Error('RPC_HTTP_READ_FAILED'), { status: response.status });
  const result = await response.json();
  if (result.jsonrpc !== '2.0' || result.id !== requestId) throw Error('RPC_RESPONSE_ID_MISMATCH');
  if (result.error) throw Object.assign(Error('RPC_RESPONSE_ERROR'), { code: result.error.code });
  return result.result;
}

try {
  const env = parseEnv(fs.readFileSync(privatePath(rpcFile), 'utf8'));
  const output = privatePath(evidenceFile);
  const endpoints = readPoolEndpoints(env.MONAD_TESTNET_RPC, env.MONAD_READ_FALLBACK_URLS, env.MONAD_READ_RPC_CAPACITIES);
  if (endpoints.length < 2) throw Error('FALLBACK_ENDPOINT_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/src/config/public-manifest.json'), 'utf8'));
  if (manifest.chainId !== 10143 || !manifest.markets[0]?.engine) throw Error('VERIFIED_TESTNET_MANIFEST_REQUIRED');
  const providers = [];
  for (let index = 0; index < endpoints.length; index++) {
    const url = endpoints[index].url;
    const [chainId, head] = await Promise.all([rpc(url, { method: 'eth_chainId' }),
      rpc(url, { method: 'eth_getBlockByNumber', params: ['finalized', false] })]);
    if (chainId !== '0x279f') throw Error('RPC_WRONG_CHAIN');
    const canonical = await rpc(url, { method: 'eth_getBlockByNumber', params: [head.number, false] });
    const age = Math.floor(Date.now() / 1000) - Number(BigInt(head.timestamp));
    if (age < 0 || age > 30 || canonical.hash !== head.hash) throw Error('RPC_HEAD_NOT_READY');
    providers.push({ index, chainId: 10143, finalizedBlock: BigInt(head.number).toString(), headAgeSeconds: age, explicitBlockMatches: true });
  }
  let inject = false, selected = null, injected = 0;
  const pool = createReadPool({ endpoints, chainId: 10143, request: async (url, request) => {
    const index = endpoints.findIndex(endpoint => endpoint.url === url);
    if (inject && index === 0 && request.method === 'eth_getBalance') {
      injected++; throw Object.assign(Error('ISOLATED_SYNTHETIC_THROTTLE'), { status: 429 });
    }
    const result = await rpc(url, request);
    if (request.method === 'eth_getBalance') selected = index;
    return result;
  } });
  const anchor = await pool.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
  const request = { method: 'eth_getBalance', params: [manifest.markets[0].engine, anchor.number] };
  const baseline = await pool.request(request);
  if (selected !== 0) throw Error('PRIMARY_BASELINE_REQUIRED');
  inject = true;
  const recovered = await pool.request(request);
  const canonical = await pool.request({ method: 'eth_getBlockByNumber', params: [anchor.number, false] });
  if (injected !== 1 || selected === 0 || selected === null || recovered !== baseline || canonical.hash !== anchor.hash)
    throw Error('READ_FAILOVER_NOT_PROVEN');
  const result = { observedAt: new Date().toISOString(), scope: 'isolated read-only pool; synthetic primary 429; no production interruption',
    providers, engine: manifest.markets[0].engine, block: BigInt(anchor.number).toString(), blockHash: anchor.hash,
    injectedProvider: 0, injectedMethod: 'eth_getBalance', injectedHttpStatus: 429, successfulReadProvider: selected,
    originalBlockHashPreserved: true, balancePreserved: true, transactionsSent: 0, requestsSent: id,
    methods: [...allowed] };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ failed: true, reason: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'READ_FAILOVER_CHECK_FAILED', transactionsSent: 0 }));
  process.exitCode = 1;
}
