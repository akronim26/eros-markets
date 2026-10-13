import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeEventLog, decodeFunctionData, http, keccak256, stringToHex, TransactionReceiptNotFoundError, type Abi, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { parseConfig, verifyListing } from '../src/config.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { PacketStore, type PacketDomain } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalTransactionSigner } from '../src/local-transaction-signer.js';
import { LocalRelay, type RelayPolicy } from '../src/local-relay.js';
import { localRpcTransport } from '../src/local-rpc.js';
import { LocalPipeline, type PipelineResult } from '../src/pipeline.js';
import { LocalLifecycle } from '../src/lifecycle.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { Worker, type PollResult } from '../src/worker.js';
import { SourceSnapshotBuffer } from '../src/source-buffer.js';
import { requireLoopback } from './local-factory-fixture.js';
import { prepareLiveSource, readLiveSource, validateLiveSource } from './live-factory-source.js';
import { auditLiveFactory } from './live-factory-audit.js';
import { checkLiveClock } from './live-clock.js';

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function atomic(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, json(value) + '\n');
  const deadline = Date.now() + 2000;
  for (;;) {
    try { renameSync(temporary, path); return; }
    catch (error) {
      // Windows readers and antivirus scanners can briefly deny delete-sharing.
      // Keep the previous complete report until replacement succeeds; never unlink it.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        || Date.now() >= deadline) throw error;
      await pause(20);
    }
  }
}
function rootDirectory(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(path, 'contracts', 'src', 'engine', 'BookRiskEngine.sol'))) {
    const parent = dirname(path); if (parent === path) throw new Error('REPOSITORY_ROOT_NOT_FOUND'); path = parent;
  }
  return path;
}
export function livePublicationDecision(snapshot: PollResult, capturedAt: bigint | null,
  lastSourceMs: bigint | null, provisional = false): { publish: boolean; reason: string | null } {
  if (snapshot.inspection.status === 'QUARANTINED') return { publish: false, reason: 'SOURCE_QUARANTINED' };
  const time = snapshot.inspection.time;
  if (!time || !['COLLECTING', 'INVALID_DEPTH'].includes(snapshot.inspection.status))
    return { publish: false, reason: snapshot.inspection.reason ?? 'SOURCE_UNAVAILABLE' };
  if (lastSourceMs !== null && time.sourceMs <= lastSourceMs) return { publish: false, reason: 'SOURCE_TIMESTAMP_NOT_ADVANCED' };
  // Before sampler finality, only a strictly newer source observation may overlap
  // its mined capture. Older invalid-depth data is retained until normal drain.
  if (provisional && capturedAt !== null && time.observedAt <= capturedAt)
    return { publish: false, reason: 'WAIT_FOR_AUTHENTIC_INDEX_PREFIX_SEAL' };
  // A fresh invalid-depth observation must interrupt validity even if it invalidates capture.
  if (snapshot.inspection.status === 'INVALID_DEPTH') return { publish: true, reason: null };
  if (capturedAt !== null && time.observedAt <= capturedAt)
    return { publish: false, reason: 'WAIT_FOR_AUTHENTIC_INDEX_PREFIX_SEAL' };
  return { publish: true, reason: null };
}

type CaptureReceipt = { transactionHash: string; status: string; blockNumber: bigint; blockHash: string;
  logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[] };
type CaptureBlock = { number: bigint; hash: string; timestamp: bigint };
export function provisionalSamplerCapture(pendingHash: string, engine: string, abi: Abi,
  receipt: CaptureReceipt | null, canonical: CaptureBlock | null): (Capture & { blockHash: string }) | null {
  if (!receipt || !canonical || receipt.transactionHash.toLowerCase() !== pendingHash.toLowerCase()
    || receipt.status !== 'success' || receipt.blockNumber !== canonical.number
    || receipt.blockHash.toLowerCase() !== canonical.hash.toLowerCase()) return null;
  const topic = keccak256(stringToHex('BookDepthCaptured(uint64,uint256,uint16,bytes32)'));
  const captures = receipt.logs.filter(log => log.address.toLowerCase() === engine.toLowerCase()
    && log.topics[0]?.toLowerCase() === topic);
  if (captures.length !== 1) return null;
  try {
    const decoded = decodeEventLog({ abi, data: captures[0]!.data, topics: captures[0]!.topics as [Hex, ...Hex[]] });
    if (decoded.eventName !== 'BookDepthCaptured') return null;
    const args = decoded.args as unknown as { observedAt: bigint; observedBlock: bigint };
    if (args.observedAt !== canonical.timestamp || args.observedBlock !== receipt.blockNumber) return null;
    return { observedAt: String(args.observedAt), observedBlock: String(args.observedBlock),
      transactionHash: pendingHash, blockHash: canonical.hash };
  } catch { return null; }
}

function samplingRequest(control: unknown): { pauseSampling: boolean; pauseRequestId?: string;
  minimumCaptureTime?: bigint; epochEnd?: bigint } {
  if (!control || typeof control !== 'object' || typeof (control as Record<string, unknown>).pauseSampling !== 'boolean')
    throw new Error('LIVE_CONTROL_PAUSE_BOOLEAN_REQUIRED');
  const request = control as Record<string, unknown>;
  if (request.pauseRequestId !== undefined && (typeof request.pauseRequestId !== 'string'
    || request.pauseRequestId.length < 1 || request.pauseRequestId.length > 128))
    throw new Error('LIVE_CONTROL_PAUSE_REQUEST_ID_REQUIRED');
  const armed = request.minimumCaptureTime !== undefined || request.epochEnd !== undefined;
  if (armed && (request.pauseSampling !== true || typeof request.pauseRequestId !== 'string'
    || typeof request.minimumCaptureTime !== 'string' || !/^[1-9][0-9]*$/.test(request.minimumCaptureTime)
    || typeof request.epochEnd !== 'string' || !/^[1-9][0-9]*$/.test(request.epochEnd)
    || BigInt(request.epochEnd) - BigInt(request.minimumCaptureTime) !== 15n))
    throw new Error('LIVE_CONTROL_ARMED_WINDOW_INVALID');
  return { pauseSampling: request.pauseSampling as boolean,
    ...(request.pauseRequestId === undefined ? {} : { pauseRequestId: request.pauseRequestId as string }),
    ...(armed ? { minimumCaptureTime: BigInt(request.minimumCaptureTime as string), epochEnd: BigInt(request.epochEnd as string) } : {}) };
}

export function liveSamplingAcknowledgement(control: unknown, samplerPending: boolean, latestValidSample?: unknown): {
  samplingPaused: boolean; samplingPauseRequestId: string | null;
} {
  const request = samplingRequest(control);
  let qualified = request.minimumCaptureTime === undefined;
  if (!qualified && latestValidSample && typeof latestValidSample === 'object') {
    const sample = latestValidSample as { timestamp?: string | bigint; observation?: { t?: string | bigint; valid?: boolean } };
    if (sample.observation?.valid === true && sample.observation.t !== undefined && sample.timestamp !== undefined) {
      const captureTime = BigInt(sample.observation.t), sealedAt = BigInt(sample.timestamp);
      qualified = captureTime >= request.minimumCaptureTime! && captureTime < request.epochEnd!
        && sealedAt >= captureTime && sealedAt < request.epochEnd!;
    }
  }
  const samplingPaused = request.pauseSampling && !samplerPending && qualified;
  return { samplingPaused, samplingPauseRequestId: samplingPaused ? request.pauseRequestId ?? null : null };
}

/** Leave time for the previous transaction to drain, then target a real pre-boundary capture. */
export function liveSamplingWindow(control: unknown, now: bigint, epochEnd: bigint): boolean {
  const request = samplingRequest(control);
  if (request.epochEnd !== undefined && request.epochEnd !== epochEnd) throw new Error('LIVE_CONTROL_ARMED_EPOCH_CHANGED');
  if (now + 4n >= epochEnd) return false;
  if (request.minimumCaptureTime !== undefined && now >= request.minimumCaptureTime - 7n && now < request.minimumCaptureTime)
    return false;
  return true;
}

type Options = { rpc: string; manifest: string; source: string; abi: string; directory: string;
  output: string; control: string; durationSeconds: number; bun: string };
type Capture = { observedAt: string; observedBlock: string; transactionHash: string };
async function runLive(options: Options): Promise<void> {
  requireLoopback(options.rpc);
  if (!Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 7200)
    throw new Error('LIVE_DURATION_MUST_BE_1_TO_7200_SECONDS');
  const source = readLiveSource(options.source), manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  if (Number(manifest.chainId) !== 31337) throw new Error('LIVE_LOCAL_MANIFEST_REQUIRED');
  const engine = manifest.markets.demo.engine as Hex;
  if (manifest.markets.demo.marketId.toLowerCase() !== source.marketId.toLowerCase()) throw new Error('LIVE_MARKET_ID_MISMATCH');
  const rawAbi = JSON.parse(readFileSync(options.abi, 'utf8')), abi: Abi = Array.isArray(rawAbi) ? rawAbi : rawAbi.abi;
  const client = createPublicClient({ transport: http(options.rpc, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }), cacheTime: 0 });
  if (await client.getChainId() !== 31337 || !(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil'))
    throw new Error('OWNED_LOCAL_ANVIL_REQUIRED');
  const block = await client.getBlock(), code = await client.getCode({ address: engine, blockNumber: block.number });
  if (!code || code === '0x') throw new Error('LIVE_ENGINE_CODE_MISSING');
  const listing = await client.readContract({ address: engine, abi, functionName: 'listing', blockNumber: block.number }) as Record<string, unknown>;
  const invalidRule = listing.invalidRule as Record<string, unknown>;
  const config = parseConfig({ ...source.config, destination: { chainId: '31337', engineAddress: engine,
    engineCodeHash: keccak256(code), abiHash: keccak256(stringToHex(JSON.stringify(abi))), marketId: source.marketId,
    sourceId: source.sourceId, sourceRulesHash: source.sourceRulesHash, signerAddress: source.indexSigner,
    listedAt: String(listing.listedAt), scheduledT: source.scheduledT,
    invalidRule: { captureGraceSecs: String(invalidRule.captureGraceSecs), voidSecs: String(invalidRule.voidSecs),
      fallbackListed: invalidRule.fallbackListed, fallbackPriceWad: String(invalidRule.fallbackPriceWad) } } });
  verifyListing(config, listing);
  if (String(listing.rulesHash).toLowerCase() !== source.rules.erosRulesHash.toLowerCase()) throw new Error('LIVE_ENGINE_RULES_HASH_MISMATCH');
  if (BigInt(source.scheduledT) - block.timestamp < 24n * 3600n) throw new Error('LIVE_SOURCE_HORIZON_EXPIRED_BEFORE_DEPLOYMENT');
  if (Math.abs(Number(block.timestamp * 1000n) - Date.now()) > 5000) throw new Error('LIVE_CHAIN_CLOCK_NOT_WALL_CLOCK');
  const directory = resolve(options.directory); mkdirSync(directory, { recursive: true });
  const identity = { engine, marketId: source.marketId, config, sourceRules: source.rules, engineCodeHash: keccak256(code) };
  const identityPath = join(directory, 'identity.json');
  if (existsSync(identityPath)) assert.deepEqual(JSON.parse(readFileSync(identityPath, 'utf8')), JSON.parse(json(identity)), 'LIVE_PUBLISHER_IDENTITY_CHANGED');
  else writeFileSync(identityPath, json(identity) + '\n', { flag: 'wx' });
  const domain: PacketDomain = { chainId: 31337n, engine, marketId: source.marketId,
    sourceId: source.sourceId, rulesHash: source.sourceRulesHash, signer: source.indexSigner };
  const sourceJournal = new Journal(join(directory, 'source.sqlite'));
  const packets = new PacketStore(join(directory, 'packets.sqlite'));
  const signer = new LocalTestSigner(join(directory, 'signer.sqlite'), domain, packets, () => BigInt(Date.now()));
  const transactionPath = join(directory, 'transactions.sqlite');
  const transactionSigner = new LocalTransactionSigner(transactionPath, !existsSync(transactionPath));
  const baseTransport = localRpcTransport(options.rpc, abi, transactionSigner);
  const transport = { ...baseTransport, simulate: async (to: string, data: Hex) => {
    const decoded = decodeFunctionData({ abi, data });
    if (decoded.functionName !== 'submitObservation') throw new Error('LIVE_INDEX_CALL_ONLY');
    const publishedAt = (decoded.args![0] as { publishedAt: bigint }).publishedAt;
    for (let attempt = 0; attempt < 20; ++attempt) {
      const current = await client.getBlock();
      if (current.timestamp >= publishedAt) {
        await client.call({ account: baseTransport.sender as Hex, to: to as Hex, data, blockNumber: current.number });
        return;
      }
      await pause(250);
    }
    throw new Error('LIVE_REAL_TIME_BLOCK_NOT_MINED');
  } };
  // No timestamp RPC is used anywhere in this driver. Only disposable Anvil actors are funded.
  const localRequest = client.request as (request: { method: string; params: unknown[] }) => Promise<unknown>;
  await localRequest({ method: 'anvil_setBalance', params: [transport.sender, '0x3635c9adc5dea00000'] });
  const policy: RelayPolicy = { gasCap: 2000000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
    maxCostWei: 4000000000000000n, headroomMs: 1000n, confirmations: 1n, timeoutMs: 5000, maxAttempts: 3, leaseMs: 60000n };
  const relay = new LocalRelay(join(directory, 'relay.sqlite'), packets, transport, policy);
  const collector = new Worker(config, new PublicPolymarket(config.poll, new RequestLimiter(100, 200)), sourceJournal, randomUUID());
  const snapshots = new SourceSnapshotBuffer(collector);
  const lifecycle = new LocalLifecycle(config, sourceJournal, randomUUID(), async () => {
    const head = await client.getBlock();
    const [liveCode, liveListing, state, halted] = await Promise.all([
      client.getCode({ address: engine, blockNumber: head.number }),
      client.readContract({ address: engine, abi, functionName: 'listing', blockNumber: head.number }),
      client.readContract({ address: engine, abi, functionName: 'sourceState', args: [source.sourceId], blockNumber: head.number }),
      client.readContract({ address: engine, abi, functionName: 'halted', blockNumber: head.number }),
    ]);
    verifyListing(config, liveListing as Record<string, unknown>);
    const liveState = state as Record<string, unknown>;
    return { chainId: 31337n, engine, marketId: source.marketId, sourceId: source.sourceId,
      engineCodeHash: liveCode ? keccak256(liveCode) : '0x', rulesHash: String(liveState.rulesHash),
      scheduledT: BigInt(source.scheduledT), halted: halted as boolean, blockNumber: head.number,
      blockHash: head.hash, blockTimestamp: head.timestamp,
      canonical: (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
      sourceState: { lastSequence: BigInt(String(liveState.lastSequence)), lastObservedAt: BigInt(String(liveState.lastObservedAt)) } };
  }, 5000n);
  const pipeline = new LocalPipeline([{ worker: collector, rules: source.rules, signer, lifecycle }], packets, relay, transport, policy);
  const samplerAccount = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 11 });
  const samplerKey = samplerAccount.getHdKey().privateKey;
  if (!samplerKey) throw new Error('LOCAL_SAMPLER_KEY_DERIVATION');
  await localRequest({ method: 'anvil_setBalance', params: [samplerAccount.address, '0x3635c9adc5dea00000'] });
  const oracle = listing.resolutionAuthority as Hex;
  const oracleCode = await client.getCode({ address: oracle });
  if (!oracleCode) throw new Error('LIVE_ORACLE_CODE_MISSING');
  const listingHash = await client.readContract({ address: engine, abi, functionName: 'listingHash' });
  const samplerManifest = join(directory, 'sampler-manifest.json'), samplerJournal = join(directory, 'sampler-journal.json');
  const samplerBinding = { chainId: 31337, engine, engineCodeHash: keccak256(code), listingHash, marketId: source.marketId,
    oracle, oracleCodeHash: keccak256(oracleCode), sender: samplerAccount.address, sampleEveryBlocks: '1' };
  let samplerPending = existsSync(samplerJournal) && !!JSON.parse(readFileSync(samplerJournal, 'utf8')).pending;
  const initialReport = existsSync(options.output) ? JSON.parse(readFileSync(options.output, 'utf8')) : null;
  if (initialReport && initialReport.engine !== engine) throw new Error('LIVE_REPORT_IDENTITY_CHANGED');
  const deployBlock = BigInt(manifest.markets.demo.deployBlock ?? manifest.startBlock ?? 0);
  if (block.number - deployBlock > 10000n) throw new Error('LIVE_ACTIVATION_DISCOVERY_BOUND');
  let activationTimestamp: bigint | null = null;
  for (let first = deployBlock; first <= block.number; first += 500n) {
    const logs = await client.getLogs({ address: engine, fromBlock: first, toBlock: first + 499n < block.number ? first + 499n : block.number });
    for (const log of logs) {
      try {
        const event = decodeEventLog({ abi, topics: log.topics, data: log.data });
        const args = event.args as unknown as Record<string, unknown>;
        if (event.eventName === 'EpochOpened' && BigInt(String(args.epoch)) === 1n) activationTimestamp = BigInt(String(args.start));
      } catch { /* Other engine events have no activation meaning. */ }
    }
  }
  if (activationTimestamp === null) throw new Error('LIVE_ACTIVATION_EVENT_NOT_FOUND');
  const activationStartMs = Number(activationTimestamp * 1000n);
  if (initialReport && Number(initialReport.startedAtMs) !== activationStartMs) throw new Error('LIVE_ACTIVATION_CHANGED');
  const deadlineMs = activationStartMs + options.durationSeconds * 1000;
  let capture: Capture | null = initialReport?.capture ?? null;
  let provisionalCapture: (Capture & { blockHash: string }) | null = null;
  let latestValidSample: unknown = initialReport?.latestValidSample ?? null;
  let samplingPaused = false, samplingPauseRequestId: string | null = null, sourceResult: PipelineResult | null = null;
  const history = packets.list(domain).filter(packet => ['MINED', 'FINALIZED'].includes(relay.get(domain, packet.packet.observation.sequence)?.state ?? ''));
  let lastSourceMs: bigint | null = history.at(-1)?.packet.sourceMs ?? null;
  let loops = initialReport?.counters?.loops ?? 0, samples = initialReport?.counters?.samples ?? 0;
  let validSamples = initialReport?.counters?.validSamples ?? 0, invalidSamples = initialReport?.counters?.invalidSamples ?? 0;
  let coalesced = initialReport?.counters?.coalesced ?? 0;
  const sampleReceipts: unknown[] = initialReport?.sampleReceipts ?? [];
  const stop = new AbortController(), shutdown = () => stop.abort();
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  let collectorFailure: unknown, collection: Promise<void> | undefined;
  const read = (functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
    client.readContract({ address: engine, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
  let readiness: Record<string, unknown> | null = null;
  const report = (completed = false, error?: string) => ({ mode: 'LOCAL_LIVE_SOURCE_FULL_ENGINE', chainId: 31337,
    engine, engineCodeHash: keccak256(code), marketId: source.marketId, activationTimestamp,
    startedAtMs: String(activationStartMs), deadlineMs: String(deadlineMs),
    updatedAtMs: String(Date.now()), completed, ...(error ? { error } : {}), samplingPaused, samplingPauseRequestId, capture, provisionalCapture,
    readiness, latestValidSample, sourceResult, sourceHealth: snapshots.snapshot()?.inspection ?? null,
    counters: { loops, samples, validSamples, invalidSamples, coalesced }, sampleReceipts,
    actualSourceTimes: true, clockWarps: 0, externalChainTransactions: 0, productionApproved: false,
    riskCalibration: source.calibration, collateral: 'LOCAL_MOCK_TOKEN', journalDirectory: directory });
  const sample = async () => {
    if (!samplerPending) {
      const estimateBlock = await client.getBlock();
      const estimate = await client.estimateContractGas({ address: engine, abi, functionName: 'samplePerp', account: samplerAccount.address,
        blockNumber: estimateBlock.number });
      const limit = (estimate * 3n + 10000n) > 30000000n ? 30000000n : estimate * 3n + 10000n;
      await atomic(samplerManifest, { ...samplerBinding, gas: { samplePerp: Number(limit) } });
    }
    const result = await new Promise<{ outcome: string; hash?: Hex }>((done, reject) => {
      const child = spawn(options.bun, ['--no-env-file', join(rootDirectory(), 'oracle/services/market-ops/src/main.ts'), 'sample', samplerManifest, samplerJournal, '--broadcast'],
        { cwd: join(rootDirectory(), 'oracle'), windowsHide: true, env: { ...process.env, RPC_URL: options.rpc,
          MARKET_OPS_PRIVATE_KEY: `0x${Buffer.from(samplerKey).toString('hex')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = ''; const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on('data', chunk => { out += chunk.toString(); }); child.stderr.on('data', chunk => { err += chunk.toString(); });
      child.once('error', reject); child.once('close', code => { clearTimeout(timer);
        if (code !== 0) { reject(new Error(`LIVE_SAMPLER_FAILED:${err.slice(-2000)}`)); return; }
        try { done(JSON.parse(out.trim().split('\n').at(-1)!)); } catch { reject(new Error('LIVE_SAMPLER_BAD_RESPONSE')); }
      });
    });
    samplerPending = existsSync(samplerJournal) && !!JSON.parse(readFileSync(samplerJournal, 'utf8')).pending;
    if (result.outcome === 'finalized' && result.hash) {
      const receipt = await client.getTransactionReceipt({ hash: result.hash });
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== 'success' || canonical.hash !== receipt.blockHash) throw new Error('LIVE_SAMPLER_RECEIPT_INVALID');
      ++samples;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== engine.toLowerCase()) continue;
        let decoded; try { decoded = decodeEventLog({ abi, topics: log.topics, data: log.data }); } catch { continue; }
        const args = decoded.args as unknown as Record<string, unknown>;
        if (decoded.eventName === 'BookDepthCaptured') capture = { observedAt: String(args.observedAt ?? args.at),
          observedBlock: String(args.observedBlock ?? args.blockNumber ?? receipt.blockNumber), transactionHash: result.hash };
        if (decoded.eventName === 'PerpObservationRecorded') {
          if (args.valid === true) { ++validSamples; latestValidSample = { transactionHash: result.hash,
            blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, timestamp: canonical.timestamp, observation: args }; }
          else ++invalidSamples;
        }
      }
      sampleReceipts.push({ hash: result.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed });
      if (sampleReceipts.length > 3000) throw new Error('LIVE_SAMPLER_RECEIPT_BOUND');
    }
  };
  try {
    await pipeline.start();
    collection = snapshots.run(stop.signal).catch(error => { collectorFailure = error; stop.abort(); });
    while (!stop.signal.aborted) {
      if (Date.now() >= deadlineMs) throw new Error('LIVE_TIME_BUDGET_EXHAUSTED');
      if (collectorFailure) throw collectorFailure;
      pipeline.renew(); ++loops;
      const readControl = () => existsSync(options.control) ? JSON.parse(readFileSync(options.control, 'utf8')) : { pauseSampling: true };
      let control = readControl();
      liveSamplingAcknowledgement(control, samplerPending); // Validate before any in-flight drain.
      // A receipt may be mined before the operator's finality check. Drain it before
      // publishing another INDEX so an as-yet-unobserved capture cannot be rewritten.
      if (samplerPending) await sample();
      provisionalCapture = null;
      if (samplerPending) {
        const pending = JSON.parse(readFileSync(samplerJournal, 'utf8')).pending;
        if (!pending || pending.action !== 'sample' || typeof pending.hash !== 'string') throw new Error('LIVE_SAMPLER_PENDING_IDENTITY_INVALID');
        try {
          const receipt = await client.getTransactionReceipt({ hash: pending.hash as Hex });
          const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
          provisionalCapture = provisionalSamplerCapture(pending.hash, engine, abi, receipt, canonical);
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        }
      }
      control = readControl();
      const acknowledgement = liveSamplingAcknowledgement(control, samplerPending, latestValidSample);
      const acknowledgementChanged = acknowledgement.samplingPaused !== samplingPaused
        || acknowledgement.samplingPauseRequestId !== samplingPauseRequestId;
      ({ samplingPaused, samplingPauseRequestId } = acknowledgement);
      if (samplingPaused) capture = null;
      // The actor re-reads canonical risk/head itself. Do not spend the final
      // pre-epoch freshness budget on unrelated INDEX/readiness work before ack.
      if (acknowledgementChanged) await atomic(options.output, report());
      const latest = await snapshots.poll();
      if (latest.inspection.status === 'QUARANTINED') throw new Error(`LIVE_SOURCE_QUARANTINED:${latest.inspection.reason}`);
      // A mined capture can protect its INDEX prefix before it is finalized.
      // Recheck its canonical block immediately before using that protection.
      if (provisionalCapture && (await client.getBlock({ blockNumber: BigInt(provisionalCapture.observedBlock) })).hash !== provisionalCapture.blockHash)
        provisionalCapture = null;
      const prefixCapture = samplerPending ? provisionalCapture : capture;
      const decision = livePublicationDecision(latest, prefixCapture ? BigInt(prefixCapture.observedAt) : null,
        lastSourceMs, samplerPending);
      const protectedSampler = !samplerPending || provisionalCapture !== null;
      const input = decision.publish && protectedSampler && control.stop !== true ? latest : { ...latest,
        inspection: { ...latest.inspection, status: 'DEGRADED' as const,
          reason: control.stop === true ? 'CONTROLLED_STOP_DRAIN' : !protectedSampler ? 'WAIT_FOR_CANONICAL_SAMPLER_CAPTURE' : decision.reason } };
      if (!decision.publish) ++coalesced;
      sourceResult = await pipeline.process(input);
      if (sourceResult.state === 'QUARANTINED') throw new Error(`LIVE_RELAY_QUARANTINED:${sourceResult.reason}`);
      if (sourceResult.state === 'MINED' || sourceResult.state === 'FINALIZED') {
        const packet = sourceResult.sequence !== null ? packets.get(domain, sourceResult.sequence) : null;
        if (packet) lastSourceMs = packet.packet.sourceMs;
      }
      const head = await client.getBlock();
      if (Math.abs(Date.now() - Number(head.timestamp * 1000n)) > 5000) throw new Error('LIVE_CHAIN_CLOCK_DRIFT');
      const [risk, caps, epoch, state, index, perp, basis, activeProfile] = await Promise.all([
        read('marketRiskView', [], head.number), read('leverageCaps', [], head.number), read('epoch', [], head.number),
        read('sourceState', [source.sourceId], head.number), read('indexTwap300', [head.timestamp], head.number),
        read('perpTwap60', [head.timestamp], head.number), read('basisTwap900', [head.timestamp], head.number),
        read('activeProfile', [], head.number),
      ]) as [Record<string, unknown>, readonly bigint[], readonly bigint[], Record<string, unknown>, Record<string, unknown>,
        Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
      if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('LIVE_READINESS_BLOCK_CHANGED');
      readiness = { blockNumber: head.number, blockHash: head.hash, timestamp: head.timestamp,
        indexAvailable: risk.indexAvailable, markAvailable: risk.markAvailable, markWad: risk.markWad,
        pricingMode: risk.pricingMode, caps, epochStart: epoch[1], epochEnd: epoch[2],
        accountingState: risk.accountingState, index, perp, basis, activeProfile, sourceState: state, risk };
      const unresolvedIndex = packets.list(domain).some(packet => {
          if (packet.state === 'EXPIRED') return false;
          const delivery = relay.get(domain, packet.packet.observation.sequence);
          return !delivery || !['MINED', 'FINALIZED'].includes(delivery.state);
      });
      if (control.stop === true && !samplerPending && !unresolvedIndex) {
        samplingPaused = true; await atomic(options.output, report(true)); break;
      }
      if (!samplingPaused && control.stop !== true) {
        if (!samplerPending && !unresolvedIndex && risk.accountingState === 0 && liveSamplingWindow(control, head.timestamp, epoch[2]!)
          && risk.indexAvailable === true && (!capture || BigInt(String(state.lastObservedAt)) > BigInt(capture.observedAt)
            || head.timestamp - BigInt(capture.observedAt) > 25n)) await sample();
      }
      await atomic(options.output, report());
      if (loops % 10 === 0) console.log(json({ mode: 'LIVE_PROGRESS', readiness, samplingPaused, samples, validSamples, invalidSamples }));
      await pause(500);
    }
    if (collectorFailure) throw collectorFailure;
  } catch (error) {
    await atomic(options.output, report(false, error instanceof Error ? error.message : String(error))); throw error;
  } finally {
    stop.abort(); await collection;
    pipeline.close(); collector.releaseLease(); relay.close(); transactionSigner.close(); signer.close(); packets.close(); sourceJournal.close();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
  }
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i], value = process.argv[i + 1];
    if (!name || !value || args.has(name) || !['--mode', '--rpc', '--manifest', '--source', '--abi', '--directory', '--output', '--control', '--duration-seconds', '--bun', '--report'].includes(name))
      throw new Error('BAD_LIVE_FACTORY_ARGUMENTS');
    args.set(name, value);
  }
  const required = (name: string) => { const value = args.get(name); if (!value) throw new Error(`MISSING_${name}`); return value; };
  if (required('--mode') === 'clock') return checkLiveClock(resolve(required('--output')));
  if (required('--mode') === 'prepare') return prepareLiveSource(resolve(required('--directory')), resolve(required('--output')));
  if (required('--mode') === 'validate') return validateLiveSource(resolve(required('--source')), resolve(required('--directory')), resolve(required('--output')));
  if (required('--mode') === 'probe') return validateLiveSource(resolve(required('--source')), resolve(required('--directory')), resolve(required('--output')), true);
  if (required('--mode') === 'audit') return auditLiveFactory(required('--rpc'), resolve(required('--abi')),
    resolve(required('--directory')), resolve(required('--report')), resolve(required('--output')));
  if (required('--mode') !== 'run') throw new Error('LIVE_MODE_PREPARE_OR_RUN_REQUIRED');
  await runLive({ rpc: required('--rpc'), manifest: resolve(required('--manifest')), source: resolve(required('--source')),
    abi: resolve(required('--abi')), directory: resolve(required('--directory')), output: resolve(required('--output')),
    control: resolve(required('--control')), durationSeconds: Number(args.get('--duration-seconds') ?? '7200'), bun: args.get('--bun') ?? process.env.BUN ?? 'bun' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
