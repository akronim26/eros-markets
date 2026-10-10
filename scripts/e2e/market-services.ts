/** Serialized testnet sampling, rollover and liquidation; retains the durable production journal. */
import { readFileSync, appendFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { RolloverBatcherAbi } from '../../oracle/services/market-ops/src/rollover-batch';
import { viemTransport } from '../../oracle/services/market-ops/src/chain';
import { marketReadTransport } from '../../oracle/services/market-ops/src/read-transport';
import { Operations } from '../../oracle/services/market-ops/src/operations';
import { manifestSchema, binding } from '../../oracle/services/market-ops/src/schema';
import { FileStore } from '../../oracle/services/market-ops/src/store';
import { readCanonicalSampleCapture } from './sample-capture.mjs';
import { readBootstrapRolloverDeferral } from './rollover-readiness.mjs';
import { ActivationSchedule, readFastStartupSupport, readPricingActivation } from './pricing-activation.mjs';
import { keeperGasCeiling, boundedRolloverHelper, requireKeeperGas, runKeeperAction } from './keeper-gas-policy.mjs';
import { sampleCadenceRemaining, isFinalizedSample } from './sampler-request-policy.mjs';
import { readEpochSamplingPolicy, requireSampleSigningWindow, SampleEpochDeferred } from './epoch-sampling-policy.mjs';
import { serviceRuntime, liquidationPolicy, keeperActions, transientServiceRead } from './service-runtime-policy.mjs';
import { assertServiceNotRetired } from './service-retirement.mjs';
import { dirname } from 'node:path';
const require = createRequire(new URL('../../oracle/services/market-ops/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256 } = require('viem');
const manifestPath = process.argv[2], journalPath = process.argv[3], evidencePath = process.argv[4];
if (!manifestPath || !journalPath || !evidencePath) throw new Error('Usage: bun --no-env-file scripts/e2e/market-services.ts <manifest> <journal> <evidence.jsonl>');
assertServiceNotRetired(dirname(journalPath));
const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
const configuredSampleCadence = manifest.sampleEveryBlocks;
const { mode, durationSeconds, end } = serviceRuntime();
const liquidation = liquidationPolicy(process.env, manifest.gas.liquidate);
if (manifest.chainId !== 10143) throw new Error('This campaign is only for Monad testnet');
const maximumKeeperGas = keeperGasCeiling(process.env.EROS_KEEPER_MAX_GAS);
manifest.rolloverHelper = boundedRolloverHelper(manifest.rolloverHelper, maximumKeeperGas);
const roleEnv = parseEnv(readFileSync(process.env.EROS_ROLE_FILE || 'tmp/fresh-testnet-20261006/roles.env', 'utf8')) as Record<string, string>;
const key = roleEnv.KEEPER_PRIVATE_KEY as `0x${string}`;
const rpc = process.env.MONAD_TESTNET_RPC || 'https://rpc-testnet.monadinfra.com';
const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 1 }) });
const reads = createPublicClient({ transport: marketReadTransport(rpc, 10143) });
const abi = JSON.parse(readFileSync('artifacts/risk/book-risk-engine-abi.json', 'utf8')).abi;
const transport = viemTransport(manifest, rpc, key);
const { privateKeyToAccount } = require('viem/accounts');
const { monadTestnet } = require('viem/chains');
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
transport.prepare = async call => {
  // Reuse all identity, nonce and simulation checks; reserve an explicit test gas ceiling.
  requireKeeperGas(call.gas, maximumKeeperGas);
  // Liquidation keeps its explicitly calibrated ceiling and uses a fresh estimate
  // for the actual productive call. It shares this keeper's single nonce journal.
  if (call.action === 'liquidate') {
    const estimate = await client.estimateContractGas({ address: call.target, abi, functionName: call.functionName,
      args: call.args, account: manifest.sender, gas: call.gas });
    const measured = estimate * 125n / 100n + 10_000n;
    requireKeeperGas(measured, call.gas);
    call = { ...call, gas: measured };
  }
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
  if (call.action === 'sample') await requireSampleSigningWindow({ client: reads, engine: manifest.engine, abi, cadence: configuredSampleCadence });
  assertServiceNotRetired(dirname(journalPath));
  const rawTransaction = await wallet.signTransaction(request);
  return { rawTransaction, hash: keccak256(rawTransaction) };
};
const listing = await reads.readContract({ address: manifest.engine, abi, functionName: 'listing' });
// Engines with index warm-up activate pricing once all windows are complete, mid-epoch.
// Older engines keep the hourly-opening promotion and its bootstrap rollover deferral.
const fastStartup = await readFastStartupSupport({ client: reads, engine: manifest.engine, abi, transient: transientServiceRead });
const activation = new ActivationSchedule({ enabled: fastStartup });
let activationWaiting: string | undefined;
const coordination = process.env.EROS_PRICE_COORDINATION_DIR;
if (coordination && !coordination.startsWith('tmp/')) throw new Error('Coordination files must stay in ignored tmp');
// Finish fallible startup reads and configuration before acquiring the outbox lock.
const store = new FileStore(journalPath, binding(manifest));
const ops = new Operations(manifest, transport, store);
const requestPath = coordination && `${coordination}/sample-request.json`;
const ackPath = coordination && `${coordination}/sample-ack.json`;
const statusPath = coordination && `${coordination}/sampler-status.json`;
const noticePath = coordination && `${coordination}/pricing-notice.json`;
// Wake-up hint for the maker after state that changes quoting readiness. Never an authorization:
// the maker rereads and simulates everything from the chain.
const notice = (event: 'activated' | 'rollover', hash?: string) => {
  if (!noticePath) return;
  try {
    writeFileSync(noticePath + '.tmp', JSON.stringify({ engine: manifest.engine, event, hash, at: Date.now() }), { mode: 0o600 });
    renameSync(noticePath + '.tmp', noticePath);
  } catch { log({ notice: 'PRICING_NOTICE_WRITE_FAILED', event }); }
};
const heartbeat = (state: 'running' | 'stopped') => {
  if (!statusPath) return;
  writeFileSync(statusPath + '.tmp', JSON.stringify({ engine: manifest.engine, pid: process.pid, state, at: Date.now() }), { mode: 0o600 });
  renameSync(statusPath + '.tmp', statusPath);
};
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
const request = () => requestPath && existsSync(requestPath) ? JSON.parse(readFileSync(requestPath, 'utf8')) : null;
let captureCache: { block: string; value: Awaited<ReturnType<typeof readCanonicalSampleCapture>> } | undefined;
const ack = async (id: string, outcome: string) => {
  if (!ackPath) return;
  const sampledBlock = store.read().lastSampleBlock;
  const capture = sampledBlock !== undefined && captureCache?.block === sampledBlock ? captureCache.value
    : await readCanonicalSampleCapture({ client: reads, engine: manifest.engine,
      event: abi.find((item: { type: string; name?: string }) => item.type === 'event' && item.name === 'BookDepthCaptured'),
      blockNumber: sampledBlock === undefined ? undefined : BigInt(sampledBlock),
      previous: existsSync(ackPath) ? JSON.parse(readFileSync(ackPath, 'utf8')) : null });
  if (sampledBlock !== undefined) captureCache = { block: sampledBlock, value: capture };
  writeFileSync(ackPath + '.tmp', JSON.stringify({ id, engine: manifest.engine, ...capture, outcome }), { mode: 0o600 });
  renameSync(ackPath + '.tmp', ackPath);
};
let rolloverCheckAfter = 0;
let knownEpochEnd: bigint | undefined;
let stop = false, samples = 0, rollovers = 0, liquidations = 0;
process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
let nextLiquidationAt = 0;
const log = (value: unknown) => { const line = JSON.stringify({ at: new Date().toISOString(), ...value as object }, (_, v) => typeof v === 'bigint' ? v.toString() : v); appendFileSync(evidencePath, line + '\n'); console.log(line); };
try {
  heartbeat('running');
  heartbeatTimer = setInterval(() => heartbeat('running'), 2000);
  log({ started: true, pid: process.pid, chainId: manifest.chainId, engine: manifest.engine, sender: manifest.sender, mode, durationSeconds, maximumKeeperGas, liquidation, fastStartup });
  while ((!stop && Date.now() < end) || store.read().pending) {
    try {
    const sampleRequest = request();
    if (sampleRequest && (sampleRequest.engine.toLowerCase() !== manifest.engine.toLowerCase() || !/^\d+$/.test(sampleRequest.id))) throw new Error('Sampler coordination identity mismatch');
    for (const action of keeperActions({ liquidationEnabled: liquidation.enabled, nextLiquidationAt, activationPending: activation.due() })) {
      if ((stop || Date.now() >= end) && !store.read().pending) break;
      if (action === 'rollover' && !store.read().pending && Date.now() < rolloverCheckAfter) continue;
      if (action === 'rollover' && !store.read().pending && !fastStartup) {
        const readiness = await readBootstrapRolloverDeferral({ client: reads, engine: manifest.engine, abi,
          scheduledT: listing.scheduledT, pending: !!store.read().pending, knownEpochEnd });
        if (readiness.defer) {
          log({ waiting: 'bootstrap rollover window', ...readiness });
          continue;
        }
      }
      if (action === 'activate' && !store.read().pending) {
        const block = await reads.getBlock();
        const decision = await readPricingActivation({ client: reads, engine: manifest.engine, abi, block });
        if (decision.done) { activation.finished(); log({ activation: 'normal-pricing', block: block.number }); continue; }
        if (!decision.due) {
          activation.waiting();
          if (activationWaiting !== decision.reason) log({ waiting: 'pricing windows', ...decision });
          activationWaiting = decision.reason;
          continue;
        }
        // The engine rechecks the same windows; a revert here only means the block moved on.
        const estimated = await client.estimateContractGas({ address: manifest.engine, abi, functionName: 'activatePricing',
          account: manifest.sender, blockNumber: block.number }).catch(() => undefined);
        if (estimated === undefined) { activation.waiting(); continue; }
        manifest.gas.activatePricing = Number(estimated * 125n / 100n + 10_000n);
      }
      if (action === 'sample' && coordination && !store.read().pending) {
        if (!sampleRequest || existsSync(ackPath!) && JSON.parse(readFileSync(ackPath!, 'utf8')).id === sampleRequest.id) continue;
      }
      if (action === 'sample' && !store.read().pending) {
        const block = await reads.getBlock();
        const blockNumber = block.number;
        const epochPolicy = await readEpochSamplingPolicy({ client: reads, engine: manifest.engine, abi, cadence: configuredSampleCadence, block });
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
          reads.readContract({ address: manifest.engine, abi, functionName: 'marketRiskView', blockNumber }),
          reads.readContract({ address: manifest.engine, abi, functionName: 'sourceState', args: [listing.indexSourceId], blockNumber }),
          reads.readContract({ address: manifest.engine, abi, functionName: 'bookDepth', blockNumber }),
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
      if (action === 'liquidate' && !store.read().pending) nextLiquidationAt = Date.now() + liquidation.intervalMs;
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
        const epoch = await reads.readContract({ address: manifest.engine, abi, functionName: 'epoch' });
        knownEpochEnd = epoch[2];
        rolloverCheckAfter = Math.min(Date.now() + 30_000, Number(epoch[2]) * 1000);
      }
      if (sampleRequest && isFinalizedSample(result)) await ack(sampleRequest.id, result.outcome);
      if (result.outcome === 'finalized' && result.action === 'sample') activation.sampled();
      if (result.outcome === 'finalized' && result.action === 'activate') { activation.finished(); notice('activated', result.hash); }
      if (result.outcome === 'finalized' && result.action === 'rollover') notice('rollover', result.hash);
      if (action === 'activate' && result.outcome === 'no-work') activation.waiting();
      if (result.outcome === 'finalized') { if (result.action === 'activate') log({ activation: 'finalized', hash: result.hash }); if (result.action === 'sample') samples++; if (result.action === 'rollover') rollovers++; if (result.action === 'liquidate') liquidations++; }
      log({ requested: action, ...result, samples, rollovers, liquidations });
      // Never let the next action jump ahead of an unresolved signed operation.
      if (result.outcome === 'sent' || result.outcome === 'pending') break;
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
      if (!transientServiceRead(error)) throw error;
      log({ retry: 'transient RPC failure', pending: !!store.read().pending });
      // Any signed request remains in the journal and is reconciled first.
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // A capture request is already serialized with its publisher; respond
    // promptly instead of adding up to two seconds to every source interval.
    await new Promise(resolve => setTimeout(resolve, coordination ? 250 : 2000));
  }
  log({ stopped: true, samples, rollovers, liquidations, pending: !!store.read().pending });
} finally {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try { heartbeat('stopped'); } finally { store.close(); }
}
