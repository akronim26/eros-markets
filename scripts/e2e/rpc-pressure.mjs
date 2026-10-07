/** Bounded read-only RPC compatibility/load probe. No wallet or signing keys are loaded. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { encodeFunctionData, decodeFunctionResult, keccak256, createPublicClient, custom } = require('viem');
const envFile = process.argv[2];
if (!envFile) throw new Error('Provide the path to a private env file containing MONAD_TESTNET_RPC');
const endpoint = parseEnv(fs.readFileSync(envFile, 'utf8')).MONAD_TESTNET_RPC;
const url = new URL(endpoint);
if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('HTTPS endpoint required');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, 'tmp', `rpc-pressure-${stamp}`);
fs.mkdirSync(directory, { mode: 0o700 });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/src/config/public-manifest.json')));
const abi = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/risk/book-risk-engine-abi.json'))).abi;
const market = manifest.markets[0], engine = market.engine;
const report = { startedAt: new Date().toISOString(), hostname: url.hostname,
  endpointFingerprint: createHash('sha256').update(endpoint).digest('hex'),
  scope: 'read-only; no broadcasts; no automatic retries; maximum 80 requests/second and 32 concurrent requests',
  status: 'running', checks: [], phases: [], chainId: null, requests: 0 };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'compatibility', id = 0, stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
const samples = [];
const forbidden = /^(eth_send|personal_|admin_|debug_|trace_|anvil_|evm_)/;
function category(message, code, status) {
  if (status === 429 || code === 429 || /rate.limit|too many requests|quota|credits|capacity|throughput/i.test(message)) return 'rate-limit';
  if (/prun|histor|archive|missing trie|state.*unavailable|state.*not available/i.test(message)) return 'historical-state-unavailable';
  if (/block.*not found|unknown block|header not found/i.test(message)) return 'block-unavailable';
  if (code === -32601 || /method.*not.*found|not supported/i.test(message)) return 'unsupported-method';
  if (/range.*large|limit.*block|block.*range/i.test(message)) return 'log-range-limit';
  if (/revert/i.test(message)) return 'execution-revert';
  if (status === 401 || status === 403) return 'authorization';
  if (status >= 500) return 'upstream-http';
  return 'rpc-error';
}
async function rpc(method, params = [], timeoutMs = 5000) {
  if (forbidden.test(method)) throw new Error('Read-only probe refused method');
  const requestId = ++id, start = performance.now(); report.requests++;
  const sample = { stage, method, ok: false, ms: 0, timeoutMs, headersMs: null, responseBytes: null, httpStatus: null, code: null, error: null };
  let value;
  try {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    sample.httpStatus = response.status;
    sample.headersMs = Math.round((performance.now() - start) * 100) / 100;
    const body = await response.text();
    sample.responseBytes = Buffer.byteLength(body);
    if (body.length > 8_000_000) throw new Error('Oversized response');
    let json; try { json = JSON.parse(body); } catch { sample.error = 'invalid-json'; throw new Error('Invalid JSON'); }
    if (!response.ok || json.error) {
      sample.code = Number.isInteger(json.error?.code) ? json.error.code : null;
      sample.error = category(String(json.error?.message ?? ''), sample.code, response.status);
      throw new Error(sample.error);
    }
    if (json.id !== requestId || !Object.hasOwn(json, 'result')) { sample.error = 'invalid-response'; throw new Error(sample.error); }
    sample.ok = true; value = json.result;
  } catch (error) {
    sample.error ??= error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'transport';
  } finally {
    sample.ms = Math.round((performance.now() - start) * 100) / 100;
    samples.push(sample);
    fs.appendFileSync(path.join(directory, 'samples.jsonl'), JSON.stringify(sample) + '\n');
  }
  if (!sample.ok) throw Object.assign(new Error(sample.error), { code: sample.code, httpStatus: sample.httpStatus });
  return value;
}
const hex = n => '0x' + BigInt(n).toString(16);
const data = (functionName, args = []) => encodeFunctionData({ abi, functionName, args });
const call = (functionName, args, block = 'latest') => rpc('eth_call', [{ to: engine, data: data(functionName, args) }, block]);
async function check(name, fn, critical = false) {
  try { const detail = await fn(); report.checks.push({ name, passed: true, detail }); emit({ check: name, passed: true, detail }); }
  catch (error) { const reason = /^[a-zA-Z0-9 _:-]{1,160}$/.test(error.message) ? error.message : 'check-failed';
    report.checks.push({ name, passed: false, error: reason }); emit({ check: name, passed: false, error: reason });
    if (critical) throw new Error(`Critical check failed: ${name}`);
  } finally { save(); await sleep(150); }
}
function stats(rows) {
  const ok = rows.filter(r => r.ok), timings = ok.map(r => r.ms).sort((a, b) => a - b);
  const percentile = p => timings.length ? timings[Math.min(timings.length - 1, Math.ceil(p * timings.length) - 1)] : null;
  const errors = {}; for (const row of rows.filter(r => !r.ok)) errors[row.error] = (errors[row.error] ?? 0) + 1;
  return { requests: rows.length, successes: ok.length, failures: rows.length - ok.length,
    successPercent: rows.length ? Number((ok.length / rows.length * 100).toFixed(2)) : null,
    p50Ms: percentile(.50), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: timings.at(-1) ?? null, errors };
}
let head, latestHash;
async function loadPhase(rps, seconds, name) {
  stage = name;
  const fresh = await rpc('eth_getBlockByNumber', ['finalized', false]);
  const block = fresh.number, fromBlock = hex(BigInt(block) - 99n);
  const owner = '0xe6088cEd9Dd029565c368a18a6044FB3fcd463aC';
  const mix = [
    ['eth_getBlockByNumber', ['finalized', false]],
    ['eth_call', [{ to: engine, data: data('marketRiskView') }, block]],
    ['eth_call', [{ to: engine, data: data('sourceState', [market.sourceId]) }, block]],
    ['eth_getTransactionCount', [owner, 'pending']],
    ['eth_getBalance', [owner, block]],
    ['eth_call', [{ to: engine, data: data('bookDepth') }, block]],
    ['eth_call', [{ to: engine, data: data('leverageCaps') }, block]],
    ['eth_getTransactionReceipt', [latestHash]],
    ['eth_getLogs', [{ address: engine, fromBlock, toBlock: block }]],
    ['eth_gasPrice', []],
  ];
  const begin = samples.length, start = performance.now(), pending = new Set();
  let sent = 0, skipped = 0, peakInFlight = 0;
  while (sent + skipped < rps * seconds && !stopped) {
    const elapsed = performance.now() - start;
    const delay = (sent + skipped) * 1000 / rps - elapsed;
    if (delay > 0) await sleep(delay);
    const rows = samples.slice(begin), bad = rows.filter(r => !r.ok);
    if (bad.some(r => r.error === 'authorization') || (bad.length >= 5 && bad.length / Math.max(1, rows.length) > .02)) break;
    if (pending.size >= 32) { skipped++; continue; }
    const [method, params] = mix[sent % mix.length]; sent++;
    const task = rpc(method, params).then(value => {
      if (method === 'eth_getBlockByNumber' && value) {
        const age = Date.now() / 1000 - Number(BigInt(value.timestamp));
        headAges.push(age);
      }
    }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task); peakInFlight = Math.max(peakInFlight, pending.size);
  }
  await Promise.all(pending);
  const duration = (performance.now() - start) / 1000, result = { name, targetRps: rps, plannedSeconds: seconds,
    actualSeconds: Number(duration.toFixed(2)), achievedRps: Number((sent / duration).toFixed(2)),
    peakInFlight, skippedForConcurrencyLimit: skipped, ...stats(samples.slice(begin)) };
  report.phases.push(result); save(); emit({ phase: result });
  return result;
}
const headAges = [];
try {
  emit({ evidence: directory, hostname: url.hostname }); save();
  await check('chain-id', async () => { const n = Number(BigInt(await rpc('eth_chainId'))); report.chainId = n;
    if (n !== 10143) throw new Error('wrong-chain'); return n; }, true);
  await check('fresh-finalized-head', async () => { head = await rpc('eth_getBlockByNumber', ['finalized', false]);
    if (!head?.hash || !head.number) throw new Error('missing-finalized-block');
    const age = Date.now() / 1000 - Number(BigInt(head.timestamp));
    if (age < -5 || age > 30) throw new Error('stale-finalized-head');
    return { block: Number(BigInt(head.number)), ageSeconds: Number(age.toFixed(2)) }; }, true);
  await check('deployment-anchor-header', async () => {
    const block = await rpc('eth_getBlockByNumber', [hex(manifest.verifiedAt.blockNumber), false]);
    if (block?.hash !== manifest.verifiedAt.blockHash) throw new Error('deployment-anchor-missing-or-mismatch');
    return { block: manifest.verifiedAt.blockNumber, canonical: true };
  });
  await check('all-deployed-runtime-hashes', async () => {
    const entries = [...Object.values(manifest.contracts), { address: engine, codehash: market.codehash }];
    const unique = [...new Map(entries.map(c => [c.address.toLowerCase(), c])).values()];
    for (const item of unique) {
      // Large code-store responses get a separate 20-second compatibility budget.
      // Record that budget explicitly; the load test still uses the service's 5 seconds.
      const code = await rpc('eth_getCode', [item.address, head.number], 20000);
      if (!code || code === '0x' || keccak256(code) !== item.codehash) throw new Error('runtime-mismatch');
      await sleep(150);
    }
    return { matched: unique.length };
  });
  await check('market-identity-and-live-risk', async () => {
    const listing = decodeFunctionResult({ abi, functionName: 'listing', data: await call('listing', [], head.number) });
    if (listing.marketId !== market.marketId || listing.indexSourceId !== market.sourceId
      || listing.registry.toLowerCase() !== manifest.contracts.MarketRegistry.address.toLowerCase()
      || listing.token.toLowerCase() !== manifest.contracts.CollateralToken.address.toLowerCase()
      || listing.resolutionAuthority.toLowerCase() !== manifest.contracts.ResolutionOracle.address.toLowerCase()) throw new Error('listing-mismatch');
    const hash = decodeFunctionResult({ abi, functionName: 'listingHash', data: await call('listingHash', [], head.number) });
    if (hash !== market.listingHash) throw new Error('listing-hash-mismatch');
    const risk = decodeFunctionResult({ abi, functionName: 'marketRiskView', data: await call('marketRiskView', [], head.number) });
    return { listingMatched: true, indexAvailable: risk.indexAvailable, markAvailable: risk.markAvailable };
  }, true);
  const direct = createPublicClient({ transport: custom({ request: ({ method, params }) => rpc(method, params ?? []) }, { retryCount: 0 }) });
  await check('frontend-deployless-multicall', async () => {
    const result = await direct.multicall({ deployless: true, allowFailure: false, blockNumber: BigInt(head.number), contracts:
      ['marketRiskView', 'leverageCaps', 'getSettlementStatus', 'bookDepth'].map(functionName => ({ address: engine, abi, functionName })) });
    return { results: result.length };
  });
  await check('historical-state-at-deployment-anchor', async () => {
    const bytes = await call('listingHash', [], hex(manifest.verifiedAt.blockNumber));
    if (decodeFunctionResult({ abi, functionName: 'listingHash', data: bytes }) !== market.listingHash) throw new Error('historical-state-mismatch');
    return 'available';
  });
  await check('historical-confirmed-wallet-receipt', async () => {
    const hash = '0x3917482df745e0596cd6b6bf210e17e36161f2b86e3d3e48d49f1d79dc41b7cd';
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (!receipt || receipt.transactionHash !== hash || receipt.status !== '0x1') throw new Error('known-receipt-missing');
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (block?.hash !== receipt.blockHash) throw new Error('receipt-block-mismatch');
    latestHash = hash; return { block: Number(BigInt(receipt.blockNumber)), canonical: true };
  });
  if (!latestHash) {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    latestHash = b.transactions?.[0];
    if (!latestHash) throw new Error('No receipt available for workload');
  }
  await check('recent-block-pinned-reads', async () => {
    for (const lag of [10n, 100n, 1000n]) {
      const result = await call('listingHash', [], hex(BigInt(head.number) - lag));
      if (decodeFunctionResult({ abi, functionName: 'listingHash', data: result }) !== market.listingHash) throw new Error('recent-state-mismatch');
    }
    return { lags: [10, 100, 1000] };
  });
  for (const range of [100, 1000]) await check(`logs-${range}-blocks`, async () => {
    const logs = await rpc('eth_getLogs', [{ address: engine, fromBlock: hex(BigInt(head.number) - BigInt(range - 1)), toBlock: head.number }]);
    if (!Array.isArray(logs)) throw new Error('logs-response-invalid'); return { entries: logs.length };
  });
  await check('sampler-simulation-and-gas-estimate', async () => {
    const tx = { from: '0x498DF93DeE8B34B27e849131B05ee77830A5c5b9', to: engine, data: data('samplePerp'), gas: hex(3_000_000) };
    await rpc('eth_call', [tx, 'pending']);
    const gas = await rpc('eth_estimateGas', [tx, 'pending']); return { gas: Number(BigInt(gas)), broadcast: false };
  });
  await check('canonical-pinned-block', async () => {
    if ((await rpc('eth_getBlockByNumber', [head.number, false]))?.hash !== head.hash) throw new Error('pinned-block-changed');
    return true;
  }, true);
  // Stop increasing load as soon as errors or the concurrency bound appear.
  for (const [rps, seconds] of [[5, 10], [10, 15], [20, 15], [40, 15], [80, 15]]) {
    if (stopped) break;
    const result = await loadPhase(rps, seconds, `ramp-${rps}rps`);
    if (result.failures || result.skippedForConcurrencyLimit || result.p95Ms > 2500) break;
    await sleep(1500);
  }
  const clean = report.phases.filter(p => !p.failures && !p.skippedForConcurrencyLimit);
  const maxClean = Math.max(0, ...clean.map(p => p.targetRps));
  if (!stopped && maxClean) {
    await sleep(3000);
    const rate = Math.min(20, maxClean);
    await loadPhase(rate, 60, `sustained-${rate}rps`);
  }
  stage = 'recovery';
  if (!stopped) await check('fresh-finalized-head-after-load', async () => {
    const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
    const age = Date.now() / 1000 - Number(BigInt(block.timestamp));
    if (age > 30 || age < -5) throw new Error('stale-finalized-head');
    return { block: Number(BigInt(block.number)), ageSeconds: Number(age.toFixed(2)) };
  });
  report.maxCleanRampRps = maxClean;
  report.finalizedHeadAgeSeconds = headAges.length ? { min: Math.min(...headAges), max: Math.max(...headAges) } : null;
  report.status = stopped ? 'interrupted' : 'completed';
} catch (error) {
  report.status = 'failed'; report.error = /^[a-zA-Z0-9 _:-]{1,160}$/.test(error.message) ? error.message : 'probe-failed';
} finally {
  report.finishedAt = new Date().toISOString();
  report.summary = stats(samples); save();
  emit({ status: report.status, report: path.join(directory, 'report.json'), requests: report.requests });
  if (report.status !== 'completed') process.exitCode = 1;
}
