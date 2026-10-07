/** Bounded, serialized testnet sampler/rollover campaign; reuses the durable production journal. */
import { readFileSync, appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { RolloverBatcherAbi } from '../../oracle/services/market-ops/src/rollover-batch';
import { viemTransport } from '../../oracle/services/market-ops/src/chain';
import { Operations } from '../../oracle/services/market-ops/src/operations';
import { manifestSchema, binding } from '../../oracle/services/market-ops/src/schema';
import { FileStore } from '../../oracle/services/market-ops/src/store';
import { readCanonicalSampleCapture } from './sample-capture.mjs';
import { readBootstrapRolloverDeferral } from './rollover-readiness.mjs';
import { keeperGasCeiling, boundedRolloverHelper, requireKeeperGas, runKeeperAction } from './keeper-gas-policy.mjs';
import { sampleCadenceRemaining, isFinalizedSample } from './sampler-request-policy.mjs';
import { readEpochSamplingPolicy, requireSampleSigningWindow, SampleEpochDeferred } from './epoch-sampling-policy.mjs';
const require = createRequire(new URL('../../oracle/services/market-ops/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256 } = require('viem');
const manifestPath = process.argv[2], journalPath = process.argv[3], evidencePath = process.argv[4];
if (!manifestPath || !journalPath || !evidencePath) throw new Error('Usage: bun --no-env-file scripts/e2e/market-services.ts <manifest> <journal> <evidence.jsonl>');
const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
const configuredSampleCadence = manifest.sampleEveryBlocks;
if (manifest.chainId !== 10143) throw new Error('This campaign is only for Monad testnet');
const maximumKeeperGas = keeperGasCeiling(process.env.EROS_KEEPER_MAX_GAS);
manifest.rolloverHelper = boundedRolloverHelper(manifest.rolloverHelper, maximumKeeperGas);
const key = parseEnv(readFileSync(process.env.EROS_ROLE_FILE || 'tmp/fresh-testnet-20261006/roles.env', 'utf8')).KEEPER_PRIVATE_KEY as `0x${string}`;
const rpc = process.env.MONAD_TESTNET_RPC || 'https://rpc-testnet.monadinfra.com';
const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 1 }) });
const abi = JSON.parse(readFileSync('artifacts/risk/book-risk-engine-abi.json', 'utf8')).abi;
const transport = viemTransport(manifest, rpc, key);
const store = new FileStore(journalPath, binding(manifest));
const { privateKeyToAccount } = require('viem/accounts');
const { monadTestnet } = require('viem/chains');
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
transport.prepare = async call => {
  // Reuse all identity, nonce and simulation checks; reserve an explicit test gas ceiling.
  requireKeeperGas(call.gas, maximumKeeperGas);
  const [balance, latest, pending] = await Promise.all([
    client.getBalance({ address: manifest.sender }),
    client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  ]);
  if (balance < call.gas * 150_000_000_000n + 100_000_000_000_000_000n) throw new Error('KEEPER_NEEDS_TEST_MON');
  if (latest !== pending) throw new Error('Untracked sender nonce; reconcile before continuing');
  const request = await wallet.prepareTransactionRequest({ to: call.target, gas: call.gas, nonce: latest,
    data: encodeFunctionData({ abi: call.functionName === 'rollover' ? RolloverBatcherAbi : abi, functionName: call.functionName, args: call.args }),
    maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  if (call.action === 'sample') await requireSampleSigningWindow({ client, engine: manifest.engine, abi, cadence: configuredSampleCadence });
  const rawTransaction = await wallet.signTransaction(request);
  return { rawTransaction, hash: keccak256(rawTransaction) };
};
const ops = new Operations(manifest, transport, store);
const listing = await client.readContract({ address: manifest.engine, abi, functionName: 'listing' });
const coordination = process.env.EROS_PRICE_COORDINATION_DIR;
if (coordination && !coordination.startsWith('tmp/')) throw new Error('Coordination files must stay in ignored tmp');
const requestPath = coordination && `${coordination}/sample-request.json`;
const ackPath = coordination && `${coordination}/sample-ack.json`;
const statusPath = coordination && `${coordination}/sampler-status.json`;
const heartbeat = (state: 'running' | 'stopped') => {
  if (!statusPath) return;
  writeFileSync(statusPath + '.tmp', JSON.stringify({ engine: manifest.engine, pid: process.pid, state, at: Date.now() }), { mode: 0o600 });
  renameSync(statusPath + '.tmp', statusPath);
};
heartbeat('running');
const heartbeatTimer = setInterval(() => heartbeat('running'), 2000);
const request = () => requestPath && existsSync(requestPath) ? JSON.parse(readFileSync(requestPath, 'utf8')) : null;
let captureCache: { block: string; value: Awaited<ReturnType<typeof readCanonicalSampleCapture>> } | undefined;
const ack = async (id: string, outcome: string) => {
  if (!ackPath) return;
  const sampledBlock = store.read().lastSampleBlock;
  const capture = sampledBlock !== undefined && captureCache?.block === sampledBlock ? captureCache.value
    : await readCanonicalSampleCapture({ client, engine: manifest.engine,
      event: abi.find((item: { type: string; name?: string }) => item.type === 'event' && item.name === 'BookDepthCaptured'),
      blockNumber: sampledBlock === undefined ? undefined : BigInt(sampledBlock),
      previous: existsSync(ackPath) ? JSON.parse(readFileSync(ackPath, 'utf8')) : null });
  if (sampledBlock !== undefined) captureCache = { block: sampledBlock, value: capture };
  writeFileSync(ackPath + '.tmp', JSON.stringify({ id, engine: manifest.engine, ...capture, outcome }), { mode: 0o600 });
  renameSync(ackPath + '.tmp', ackPath);
};
let rolloverCheckAfter = 0;
let knownEpochEnd: bigint | undefined;
let stop = false, samples = 0, rollovers = 0;
process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
const durationSeconds = Number(process.env.EROS_SERVICE_DURATION_SECONDS ?? '5400');
if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 86400) throw new Error('INVALID_SERVICE_DURATION');
const end = Date.now() + durationSeconds * 1000;
const log = (value: unknown) => { const line = JSON.stringify({ at: new Date().toISOString(), ...value as object }, (_, v) => typeof v === 'bigint' ? v.toString() : v); appendFileSync(evidencePath, line + '\n'); console.log(line); };
try {
  log({ started: true, pid: process.pid, chainId: manifest.chainId, engine: manifest.engine, sender: manifest.sender, durationSeconds, maximumKeeperGas });
  while ((!stop && Date.now() < end) || store.read().pending) {
    try {
    const sampleRequest = request();
    if (sampleRequest && (sampleRequest.engine.toLowerCase() !== manifest.engine.toLowerCase() || !/^\d+$/.test(sampleRequest.id))) throw new Error('Sampler coordination identity mismatch');
    for (const action of ['rollover', 'sample'] as const) {
      if ((stop || Date.now() >= end) && !store.read().pending) break;
      if (action === 'rollover' && !store.read().pending && Date.now() < rolloverCheckAfter) continue;
      if (action === 'rollover' && !store.read().pending) {
        const readiness = await readBootstrapRolloverDeferral({ client, engine: manifest.engine, abi,
          scheduledT: listing.scheduledT, pending: !!store.read().pending, knownEpochEnd });
        if (readiness.defer) {
          log({ waiting: 'bootstrap rollover window', ...readiness });
          continue;
        }
      }
      if (action === 'sample' && coordination && !store.read().pending) {
        if (!sampleRequest || existsSync(ackPath!) && JSON.parse(readFileSync(ackPath!, 'utf8')).id === sampleRequest.id) continue;
      }
      if (action === 'sample' && !store.read().pending) {
        const block = await client.getBlock();
        const blockNumber = block.number;
        const epochPolicy = await readEpochSamplingPolicy({ client, engine: manifest.engine, abi, cadence: configuredSampleCadence, block });
        knownEpochEnd = epochPolicy.epochEnd;
        manifest.sampleEveryBlocks = epochPolicy.cadence;
        // Keep enough time for inclusion before accounting expires. A successful
        // late sample would see an empty book and discard the pending capture.
        if (!epochPolicy.admit) {
          log({ waiting: 'epoch closing; prioritize rollover', ...epochPolicy });
          if (sampleRequest) await ack(sampleRequest.id, 'epoch-closing');
          continue;
        }
        // Do not acknowledge a request that has not executed. Keep it outstanding
        // and avoid expensive readiness/estimation RPCs until the cadence allows it.
        if (sampleCadenceRemaining(store.read().lastSampleBlock, blockNumber, manifest.sampleEveryBlocks) > 0n) continue;
        // Estimate against the same block while readiness reads are in flight.
        // An estimate never grants readiness; its error is considered only after
        // the source, accounting and funded-depth gates below have passed.
        const [risk, source, depth, estimated] = await Promise.all([
          client.readContract({ address: manifest.engine, abi, functionName: 'marketRiskView', blockNumber }),
          client.readContract({ address: manifest.engine, abi, functionName: 'sourceState', args: [listing.indexSourceId], blockNumber }),
          client.readContract({ address: manifest.engine, abi, functionName: 'bookDepth', blockNumber }),
          client.estimateContractGas({ address: manifest.engine, abi, functionName: 'samplePerp', account: manifest.sender, blockNumber })
            .then((gas: bigint) => ({ gas, error: undefined }), (error: unknown) => ({ gas: undefined, error })),
        ]);
        // This instantaneous source freshness check is an additional gate.
        // The contract's bookDepth also requires a complete INDEX300 window;
        // sampling resumes only after that window and funded depth recover.
        const sourceFresh = source.configured && source.lastObservedAt <= block.timestamp && block.timestamp - source.lastObservedAt <= 25n;
        if (!sourceFresh || risk.accountingState !== 0) {
          log({ waiting: 'source/accounting readiness', sourceFresh, accountingState: risk.accountingState });
          if (sampleRequest) await ack(sampleRequest.id, 'not-ready');
          continue;
        }
        if (depth.bidDepthLots < listing.depthNLots || depth.askDepthLots < listing.depthNLots || depth.bidWad === 0n
          || depth.askWad < depth.bidWad || depth.askWad - depth.bidWad > listing.maxSpreadWad) {
          log({ waiting: 'funded two-sided book depth' });
          if (sampleRequest) await ack(sampleRequest.id, 'book-not-ready');
          continue;
        }
        if (estimated.gas === undefined) throw estimated.error;
        const gas = estimated.gas;
        manifest.gas.samplePerp = Number(gas * 125n / 100n + 10_000n);
      }
      const attempted = await runKeeperAction({ run: () => ops.tick({ action }, true),
        rolloverCeiling: action === 'rollover' && manifest.rolloverHelper ? BigInt(manifest.rolloverHelper.gasCeiling) : undefined,
        hasPending: () => !!store.read().pending,
        onLimit: async error => {
          log({ waiting: 'keeper gas estimate exceeds configured ceiling', requested: action,
            estimatedGasWithMargin: error.gas, maximumKeeperGas: error.ceiling,
            remediation: 'Review measured gas, operator funding and EROS_KEEPER_MAX_GAS before restarting.' });
          if (action === 'rollover') rolloverCheckAfter = Date.now() + 30_000;
          if (action === 'sample' && sampleRequest) await ack(sampleRequest.id, 'gas-limit-exceeded');
        } });
      if (attempted.limited) continue;
      const result = attempted.result;
      if (action === 'rollover' && result.outcome === 'no-work') {
        const epoch = await client.readContract({ address: manifest.engine, abi, functionName: 'epoch' });
        knownEpochEnd = epoch[2];
        rolloverCheckAfter = Math.min(Date.now() + 30_000, Number(epoch[2]) * 1000);
      }
      if (sampleRequest && isFinalizedSample(result)) await ack(sampleRequest.id, result.outcome);
      if (result.outcome === 'finalized') { if (result.action === 'sample') samples++; if (result.action === 'rollover') rollovers++; }
      log({ requested: action, ...result, samples, rollovers });
    }
    } catch (error) {
      // This refusal occurs before signing; any existing signed operation still
      // follows the ordinary pending-receipt path and is never discarded here.
      if (error instanceof SampleEpochDeferred && !store.read().pending) {
        log({ waiting: error.message, ...error.context });
        const current = request();
        if (current && error.message === 'SAMPLE_EPOCH_CLOSING') await ack(current.id, 'epoch-closing');
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      if ((error as Error).message === 'KEEPER_NEEDS_TEST_MON' && !store.read().pending) {
        log({ waiting: 'keeper gas wallet below policy minimum' });
        const current = request();
        if (current) await ack(current.id, 'keeper-unfunded');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      const transient = (error as { walk?: (predicate: (e: Error) => boolean) => unknown }).walk?.(
        e => ['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError'].includes(e.name));
      if (!transient) throw error;
      log({ retry: 'transient RPC failure', pending: !!store.read().pending });
      // Any signed request remains in the journal and is reconciled first.
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // A capture request is already serialized with its publisher; respond
    // promptly instead of adding up to two seconds to every source interval.
    await new Promise(resolve => setTimeout(resolve, coordination ? 250 : 2000));
  }
  log({ stopped: true, samples, rollovers, pending: !!store.read().pending });
} finally { clearInterval(heartbeatTimer); heartbeat('stopped'); store.close(); }
