import { makerReadinessDelay } from './maker-readiness-policy.mjs';
import { assertServiceNotRetired } from './service-retirement.mjs';
import { serviceRuntime, transientServiceRead } from './service-runtime-policy.mjs';
import { makerPolicy, makerOrderIsCurrent, makerMaintenance, makerCaptureDelay, retryableMakerAdmission,
  makerQuoteReference, makerBootstrapHold } from './maker-maintenance-policy.mjs';
import { ReadinessNotifier } from './readiness-notifier.mjs';
import { readFastStartupSupport } from './pricing-activation.mjs';
import { monadReadTransport } from '../../packages/pricefeed/dist/src/monad-preflight.js';
import { makerReceiptOutcome } from './maker-receipt.mjs';
import { makerPerpPromotion } from './maker-sampling.mjs';
import { MakerPairedMaintenance, makerPairContext } from './maker-paired-maintenance.mjs';
import { verifyRepairCalldata, repairReceiptOutcome, makerOwnerOrder, makerLoopDelay, simulateEpochRepair } from './maker-epoch-repair.mjs';
import { MAKER_CLEANUP_SCAN_PAGE, MAKER_CLEANUP_MAX_BATCH, MAKER_CLEANUP_MAX_BATCHES_PER_EPOCH,
  verifiedMakerQuote, staleMakerOrder, cleanupReceiptOutcome, verifyCleanupCalldata } from './maker-cleanup.mjs';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, keccak256, encodeFunctionData, decodeEventLog,
  decodeFunctionData, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { monadTestnet } = require('viem/chains');
const [publicDir, privateDir, rpcFile] = process.argv.slice(2);
if (!publicDir?.startsWith('artifacts/deployments/') || !privateDir?.startsWith('tmp/') || !rpcFile)
  throw Error('EXPLICIT_CAMPAIGN_PATHS_REQUIRED');
assertServiceNotRetired(privateDir + '/services');
const roles = parseEnv(fs.readFileSync(privateDir + '/roles.env', 'utf8'));
const m = JSON.parse(fs.readFileSync(publicDir + '/services/market-ops.json'));
const sourceId = JSON.parse(fs.readFileSync(publicDir + '/services/pricefeed-config.json')).destination.sourceId;
const abi = JSON.parse(fs.readFileSync('artifacts/risk/book-risk-engine-abi.json')).abi;
const rpcEnv = parseEnv(fs.readFileSync(rpcFile, 'utf8')), rpc = rpcEnv.MONAD_TESTNET_RPC;
process.env.MONAD_READ_FALLBACK_URLS ||= rpcEnv.MONAD_READ_FALLBACK_URLS || '';
process.env.MONAD_READ_RPC_CAPACITIES ||= rpcEnv.MONAD_READ_RPC_CAPACITIES || '';
const client = createPublicClient({ chain: monadTestnet, transport: http(rpc, { timeout: 10000, retryCount: 1 }) });
const reads = createPublicClient({ chain: monadTestnet, transport: monadReadTransport(rpc) });
const path = privateDir + '/maker-journal.json', logPath = privateDir + '/maker-evidence.jsonl';
const lockPath = path + '.lock';
let state;
const save = () => {
  const fd = fs.openSync(path + '.tmp', 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(path + '.tmp', path);
  const dir = fs.openSync(dirname(path), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
};
const log = value => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value }, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  fs.appendFileSync(logPath, line + '\n'); console.log(line);
};
const read = (functionName, args = [], blockNumber) => reads.readContract({ address: m.engine, abi, functionName, args, blockNumber });
const coordination = process.env.EROS_PRICE_COORDINATION_DIR;
if (coordination && !coordination.startsWith('tmp/')) throw Error('COORDINATION_PATH_REQUIRED');
// Publisher/keeper notices wake the maker early; every delay below remains an upper bound.
const notifier = new ReadinessNotifier({ directory: coordination });
const wait = ms => notifier.wait(ms);
let stopped = false;
process.on('SIGTERM', () => { stopped = true; notifier.close(); }); process.on('SIGINT', () => { stopped = true; notifier.close(); });
const runtime = serviceRuntime(process.env, '4800'), policy = makerPolicy();
const owners = [['buy', privateKeyToAccount(roles.MAKER_BUY_PRIVATE_KEY)], ['sell', privateKeyToAccount(roles.MAKER_SELL_PRIVATE_KEY)]];
if (owners[0][1].address.toLowerCase() === owners[1][1].address.toLowerCase()) throw Error('SEPARATE_MAKER_OWNERS_REQUIRED');
const maintenance = new Map();
const pairedMaintenance = new MakerPairedMaintenance();
const cleanupScans = new Map(), verifiedQuotes = new Map(), removedOrders = new Set();
let progressed = false;
let maximumCleanupOrders = MAKER_CLEANUP_MAX_BATCH;
let promotedPerpAt = 0n, promotionBlock;
async function latestPerpPromotion() {
  const journal = JSON.parse(fs.readFileSync(privateDir + '/services/market-ops-journal.json', 'utf8'));
  const block = journal.lastSampleBlock;
  if (block === undefined || block === promotionBlock) return promotedPerpAt;
  if (!/^\d+$/.test(block)) throw Error('MAKER_SAMPLE_BLOCK_INVALID');
  promotedPerpAt = await makerPerpPromotion({ client: reads, engine: m.engine,
    event: abi.find(item => item.type === 'event' && item.name === 'PerpObservationRecorded'),
    blockNumber: BigInt(block), previous: promotedPerpAt });
  promotionBlock = block;
  return promotedPerpAt;
}
const eventsOf = receipt => receipt.logs.filter(l => l.address.toLowerCase() === m.engine.toLowerCase())
  .flatMap(l => { try { return [decodeEventLog({ abi, data: l.data, topics: l.topics })]; } catch { return []; } });

async function canonicalReceipt(hash) {
  let receipt;
  try { receipt = await reads.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw Error('MAKER_RECEIPT_HASH_MISMATCH');
  const [block, finalized] = await Promise.all([
    reads.getBlock({ blockNumber: receipt.blockNumber }), reads.getBlock({ blockTag: 'finalized' }),
  ]);
  if (block.hash !== receipt.blockHash) throw Error('MAKER_RECEIPT_NONCANONICAL');
  return { receipt, block, finalized: finalized.number >= receipt.blockNumber };
}

async function reconcile() {
  if (!state.pending) return true;
  const p = state.pending, owner = owners.find(([side]) => side === p.side)?.[1];
  if (!owner || keccak256(p.raw) !== p.hash) throw Error('MAKER_PENDING_IDENTITY_MISMATCH');
  const tx = parseTransaction(p.raw);
  if (tx.chainId !== 10143 || tx.to?.toLowerCase() !== m.engine.toLowerCase() || (tx.value ?? 0n) !== 0n
    || (await recoverTransactionAddress({ serializedTransaction: p.raw })).toLowerCase() !== owner.address.toLowerCase())
    throw Error('MAKER_PENDING_IDENTITY_MISMATCH');
  if (p.action === 'cleanup' || p.action === 'epochRepair') {
    (p.action === 'cleanup' ? verifyCleanupCalldata : verifyRepairCalldata)(p, decodeFunctionData({ abi, data: tx.data }));
    if (tx.type !== 'eip1559' || !tx.gas || tx.gas > 2_000_000n || !tx.maxFeePerGas || tx.maxFeePerGas > 150_000_000_000n
      || tx.maxPriorityFeePerGas === undefined || tx.maxPriorityFeePerGas > 2_000_000_000n) throw Error('MAKER_CLEANUP_FEE_MISMATCH');
  }
  const observed = await canonicalReceipt(p.hash);
  if (!observed) {
    const returned = await client.sendRawTransaction({ serializedTransaction: p.raw });
    if (returned.toLowerCase() !== p.hash.toLowerCase()) throw Error('MAKER_BROADCAST_HASH_MISMATCH');
    return false;
  }
  if (!observed.finalized) return false;
  if (observed.receipt.status !== 'success') throw Error('MAKER_TRANSACTION_REVERTED');
  const trader = await read('participantId', [owner.address], observed.block.number);
  const events = eventsOf(observed.receipt);
  let repaired;
  if (p.action === 'cleanup' || p.action === 'epochRepair') {
    const orders = await Promise.all(p.cancelIds.map(id => read('getOrder', [id], observed.block.number)));
    const input = { pending: p, events, orders, trader, owner: owner.address, at: Number(observed.block.timestamp) * 1000 };
    repaired = p.action === 'epochRepair' ? repairReceiptOutcome(input) : undefined;
    const record = repaired?.cleanup ?? cleanupReceiptOutcome(input);
    state.cleanups ??= []; state.cleanups.push(record);
    for (const id of p.cancelIds) removedOrders.add(id); // Exact old generations cannot revive.
    log({ cleanupFinalized: true, ...record });
    if (p.action === 'cleanup') {
      delete state.pending; state.nextSide = p.side === 'buy' ? 'sell' : 'buy';
      progressed = true; save(); return true;
    }
  }
  const outcome = repaired?.quote ?? makerReceiptOutcome({ pending: p, events, trader,
    owner: owner.address, at: Number(observed.block.timestamp) * 1000 });
  if (outcome.kind === 'rejected') {
    state.rejected ??= [];
    state.rejected.push(outcome.record);
    log({ rejected: true, hash: p.hash, side: p.side, reason: state.rejected.at(-1).reason });
  } else {
    state.completed.push(outcome.record); log({ finalized: true, ...outcome.record });
    verifiedQuotes.set(p.hash, { ...outcome.record, blockNumber: observed.block.number.toString() });
  }
  pairedMaintenance.finalized({ hash: p.hash, side: p.side, accepted: outcome.kind !== 'rejected',
    receiptAt: Number(observed.block.timestamp) * 1000 });
  delete state.pending; state.nextSide = p.side === 'buy' ? 'sell' : 'buy';
  progressed = true; save(); maintenance.delete(p.side); return true;
}

async function verifyHistoricalQuote(record, trader, owner) {
  const cached = verifiedQuotes.get(record.hash);
  if (cached) return cached;
  const observed = await canonicalReceipt(record.hash);
  if (!observed?.finalized || observed.receipt.status !== 'success') throw Error('MAKER_LEGACY_RECEIPT_UNAVAILABLE');
  const verified = verifiedMakerQuote(record, eventsOf(observed.receipt), trader, owner,
    Number(observed.block.timestamp) * 1000);
  verified.blockNumber = observed.block.number.toString();
  verifiedQuotes.set(record.hash, verified);
  // Legacy entries gain their canonical IDs; original hashes, epoch and history stay intact.
  Object.assign(record, verified); save();
  return verified;
}

async function cleanupOwnStale({ side, account, trader, epoch, accountEpoch, block, allowRepair }) {
  const key = `${epoch}:${accountEpoch}`;
  let scan = cleanupScans.get(side);
  if (!scan || scan.key !== key) {
    scan = { key, cursor: 0, records: state.completed.filter(record => record.side === side
      && !removedOrders.has(verifiedQuotes.get(record.hash)?.orderId)), done: false };
    cleanupScans.set(side, scan);
  }
  if (scan.done) return { ready: true };
  const page = scan.records.slice(scan.cursor, scan.cursor + MAKER_CLEANUP_SCAN_PAGE);
  // Only canonical finalized absence can enter the process-local removal cache.
  // A restart reconstructs this proof; journal IDs alone never authorize skipping reads.
  const finalized = await reads.getBlock({ blockTag: 'finalized' });
  const results = await Promise.allSettled(page.map(async record => {
    const verified = await verifyHistoricalQuote(record, trader, account.address);
    if (removedOrders.has(verified.orderId)) return { verified, absent: true };
    if (BigInt(verified.blockNumber) > finalized.number) return { deferred: true };
    const order = await read('getOrder', [verified.orderId], finalized.number);
    return { verified, order, absent: order.size === 0n && (order.flags & 4) === 0 };
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  if ((await reads.getBlock({ blockNumber: finalized.number })).hash !== finalized.hash) throw Error('MAKER_CLEANUP_SCAN_NONCANONICAL');
  if (results.some(result => result.value.deferred)) return { ready: false };
  const candidates = [];
  for (const { value } of results) {
    if (value.absent) { removedOrders.add(value.verified.orderId); continue; }
    if (staleMakerOrder(value.order, value.verified, { trader, side, epoch, accountEpoch, blockNumber: block.number })
      && !candidates.some(record => record.orderId === value.verified.orderId)) candidates.push(value.verified);
  }
  const cancels = candidates.slice(0, maximumCleanupOrders).map(record => record.orderId);
  if (!cancels.length) {
    scan.cursor += page.length; scan.done = scan.cursor >= scan.records.length;
    if (page.length) progressed = true;
    if (!scan.done) log({ side, waiting: 'bounded historical order scan', checked: scan.cursor, total: scan.records.length });
    return { ready: scan.done };
  }
  const used = (state.cleanups ?? []).filter(record => record.side === side && record.epoch === epoch.toString()).length;
  if (used >= MAKER_CLEANUP_MAX_BATCHES_PER_EPOCH) {
    log({ side, waiting: 'cleanup action budget', maximum: MAKER_CLEANUP_MAX_BATCHES_PER_EPOCH }); return { ready: false };
  }
  const latest = state.completed.findLast(record => record.side === side);
  if (allowRepair && maximumCleanupOrders >= 2 && candidates.length === 1 && scan.cursor + page.length === scan.records.length
    && candidates[0].hash === latest?.hash) return { ready: true, repair: candidates[0] };
  await submitCleanup({ side, account, epoch, block, cancels });
  return { ready: false };
}

async function submitCleanup({ side, account, epoch, block, cancels }) {
  pairedMaintenance.clear();
  // Cancellation does not require fresh pricing and never places or takes an order.
  const args = [cancels, []];
  if (await client.getChainId() !== 10143) throw Error('MAKER_WRONG_CHAIN');
  const simulation = await client.simulateContract({ address: m.engine, abi, functionName: 'batch', args,
    account: account.address, blockNumber: block.number });
  if (!Array.isArray(simulation.result) || simulation.result.length !== 0) throw Error('MAKER_CLEANUP_SIMULATION_MISMATCH');
  const gas = (await client.estimateContractGas({ address: m.engine, abi, functionName: 'batch', args,
    account: account.address, blockNumber: block.number })) * 125n / 100n + 10000n;
  if (gas > 2_000_000n) { log({ side, waiting: 'cleanup gas ceiling', estimatedGas: gas }); return false; }
  const [latest, pending, balance, canonical] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    client.getBalance({ address: account.address }), reads.getBlock({ blockNumber: block.number }),
  ]);
  if (latest !== pending) throw Error('MAKER_UNTRACKED_NONCE');
  if (balance < gas * 150_000_000_000n + 100_000_000_000_000_000n) {
    log({ side, waiting: 'maker gas wallet below policy minimum' }); return false;
  }
  if (canonical.hash !== block.hash) throw Error('MAKER_PREVIEW_NONCANONICAL');
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
  const request = await wallet.prepareTransactionRequest({ to: m.engine, data: encodeFunctionData({ abi, functionName: 'batch', args }),
    gas, nonce: latest, maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
  assertServiceNotRetired(privateDir + '/services');
  const raw = await wallet.signTransaction(request);
  state.pending = { hash: keccak256(raw), raw, side, epoch: epoch.toString(), action: 'cleanup', functionName: 'batch', cancelIds: cancels };
  save(); log({ cleanupSubmitted: true, side, hash: state.pending.hash, cancelIds: cancels });
  await reconcile();
  // Re-read this page after canonical cleanup; crashes restart a bounded scan safely.
  return false;
}

async function lastQuote(side, epoch, trader) {
  const previous = state.completed.findLast(v => v.epoch === epoch.toString() && v.side === side);
  if (!previous || previous.orderId !== undefined) return previous;
  // Resolve legacy hashes to their exact finalized order before replacing it.
  const observed = await canonicalReceipt(previous.hash);
  if (!observed?.finalized || observed.receipt.status !== 'success') throw Error('MAKER_LEGACY_RECEIPT_UNAVAILABLE');
  const placed = eventsOf(observed.receipt).filter(e => e.eventName === 'OrderPlaced' && e.args.trader === trader);
  if (placed.length !== 1 || placed[0].args.tick !== previous.tick) throw Error('MAKER_LEGACY_ORDER_MISMATCH');
  Object.assign(previous, { orderId: Number(placed[0].args.id), trader, size: placed[0].args.size.toString(),
    at: Number(observed.block.timestamp) * 1000 });
  save(); return previous;
}

let lock;
try {
  lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, engine: m.engine }) + '\n'); fs.fsyncSync(lock);
  state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { engine: m.engine, completed: [] };
  if (state.engine.toLowerCase() !== m.engine.toLowerCase() || !Array.isArray(state.completed)) throw Error('MAKER_JOURNAL_ENGINE_MISMATCH');
  if (await client.getChainId() !== 10143) throw Error('MAKER_WRONG_CHAIN');
  if ((await reads.call({ data: '0x73' + m.engine.slice(2) + '3f60005260206000f3', blockTag: 'finalized' })).data !== m.engineCodeHash)
    throw Error('MAKER_ENGINE_RUNTIME_MISMATCH');
  const listing = await read('listing');
  const fastStartup = await readFastStartupSupport({ client: reads, engine: m.engine, abi, transient: transientServiceRead });
  const bandTicks = Number(listing.bootstrapBandWad / 10n ** 15n);
  maximumCleanupOrders = Math.min(MAKER_CLEANUP_MAX_BATCH, Number(await read('maxBatchActions')));
  if (!Number.isInteger(maximumCleanupOrders) || maximumCleanupOrders < 1) throw Error('MAKER_CLEANUP_BATCH_LIMIT_INVALID');
  if (policy.targetLots < listing.depthNLots) throw Error('MAKER_TARGET_BELOW_REQUIRED_DEPTH');
  log({ started: true, pid: process.pid, mode: runtime.mode, durationSeconds: runtime.durationSeconds, policy, fastStartup,
    notifications: notifier.watching });
  while ((!stopped && Date.now() < runtime.end) || state.pending) {
    progressed = false;
    try {
      if (!await reconcile()) { await wait(1000); continue; }
      if (stopped || Date.now() >= runtime.end) break;
      for (const [side, account] of makerOwnerOrder(owners, state.nextSide)) {
        if (stopped || Date.now() >= runtime.end) break;
        try {
        // Keep account/order views at least as new as this pool's prior finalized receipt.
        const block = await reads.getBlock({ blockTag: 'finalized' });
        const [risk, epoch, source, trader, accountState, depth, warmupPoint] = await Promise.all([
          read('marketRiskView', [], block.number), read('marketOrderEpoch', [], block.number),
          read('sourceState', [sourceId], block.number), read('participantId', [account.address], block.number),
          read('account', [account.address], block.number), read('bookDepth', [], block.number),
          fastStartup ? read('warmupIndex', [], block.number) : Promise.resolve(null),
        ]);
        const warmup = warmupPoint ? { available: warmupPoint[0], pointWad: warmupPoint[1] } : undefined;
        const cleanupContext = { side, account, trader, epoch, accountEpoch: accountState.orderEpoch, block };
        const sourceReady = source.configured && source.lastObservedAt <= block.timestamp && block.timestamp - source.lastObservedAt <= 18n;
        const cleanup = risk.accountingState === 0 && trader ? await cleanupOwnStale({ ...cleanupContext,
          allowRepair: (risk.indexAvailable || warmup?.available === true) && sourceReady }) : { ready: true };
        if (!cleanup.ready) {
          if (state.pending) break;
          continue;
        }
        const repair = cleanup.repair;
        const cancelInstead = async () => { if (repair) await submitCleanup({ ...cleanupContext, cancels: [repair.orderId] }); };
        const readinessDelay = makerReadinessDelay(risk, warmup);
        if (readinessDelay) { log({ side, waiting: 'fresh index and ready accounting', retryAfterMs: readinessDelay }); await wait(readinessDelay); break; }
        if (!sourceReady) {
          log({ side, waiting: 'fresh source headroom' }); continue;
        }
        if (!trader) throw Error('MAKER_OWNER_NOT_FUNDED');
        const previous = await lastQuote(side, epoch, trader);
        const [rawOrder, preview] = await Promise.all([
          previous ? read('getOrder', [previous.orderId], block.number) : Promise.resolve(null), read('previewAccount', [trader], block.number),
        ]);
        const current = makerOrderIsCurrent(rawOrder, trader, side, epoch, accountState.orderEpoch, block.number) ? rawOrder : null;
        const reference = makerQuoteReference(risk, warmup);
        if (!reference) { log({ side, waiting: 'quote reference' }); continue; }
        const referenceTick = Number(reference.wad / 10n ** 15n);
        const tick = referenceTick + (side === 'buy' ? -10 : 10);
        if (tick < 1 || tick > 999) { log({ side, waiting: 'source outside maker quote range' }); await cancelInstead(); if (state.pending) break; continue; }
        const attempts = [...state.completed, ...(state.rejected ?? [])].filter(v => v.epoch === epoch.toString() && v.side === side);
        const decision = makerMaintenance({ side, positionLots: preview.positionLots,
          reservedLots: preview.orders.bidLots + preview.orders.askLots,
          liveLots: current?.size ?? 0n, liveTick: current?.tick ?? 0, tick,
          depthLots: side === 'buy' ? depth.bidDepthLots : depth.askDepthLots, requiredDepthLots: listing.depthNLots,
          actions: attempts.length, lastActionAt: Math.max(0, ...attempts.map(v => v.at ?? 0)), policy });
        if (makerBootstrapHold({ pricingMode: risk.pricingMode, decision, liveTick: current?.tick ?? 0, referenceTick,
          bandTicks, marginTicks: policy.repriceTicks })) {
          maintenance.delete(side);
          log({ side, waiting: 'bootstrap quote stability', reason: decision.reason, liveTick: current?.tick, referenceTick });
          continue;
        }
        if (decision.action !== 'quote') {
          maintenance.delete(side);
          if (decision.action === 'wait') log({ side, waiting: decision.reason });
          await cancelInstead(); if (state.pending) break;
          continue;
        }
        const pairInput = { side, context: makerPairContext({ engine: m.engine, epoch, risk, sourceId, source }),
          sequence: source.lastSequence, observedAt: source.lastObservedAt };
        const usePair = decision.reason === 'reprice' && pairedMaintenance.canUse(pairInput);
        if (!usePair) {
          const latestPerpAt = decision.repair ? 0n : await latestPerpPromotion();
          let pendingMaintenance = maintenance.get(side);
          if (!pendingMaintenance) { pendingMaintenance = { requestedAt: Date.now(), initialPerpAt: latestPerpAt }; maintenance.set(side, pendingMaintenance); }
          const captureDelay = makerCaptureDelay({ repair: decision.repair, ...pendingMaintenance, latestPerpAt, maxWaitMs: policy.captureWaitMs });
          if (captureDelay) { log({ side, waiting: 'pending book capture promotion', retryAfterMs: captureDelay }); continue; }
        }
        const place = { kind: 2, isBuy: side === 'buy', reduceOnly: false, tick, size: decision.size, maxFills: 8, expiryBlock: 0 };
        const functionName = current || repair ? 'batch' : 'placeOrder';
        const args = current || repair ? [[repair?.orderId ?? previous.orderId], [place]] : [place];
        // previewOrder models a taker; a warm-up quote rests only as POST_ONLY, so the
        // simulation below is its authoritative admission check.
        if (!current && !reference.warmup) {
          const admission = await read('previewOrder', [trader, side === 'buy' ? 0 : 1, tick, decision.size, false], block.number);
          if (admission.rejection || admission.acceptedCapLots < decision.size) {
            log({ side, waiting: 'maker admission', reason: admission.rejection }); await cancelInstead(); if (state.pending) break; continue;
          }
        }
        const simulate = () => client.simulateContract({ address: m.engine, abi, functionName, args, account: account.address, blockNumber: block.number });
        const simulation = repair ? await simulateEpochRepair(simulate) : await simulate();
        if (!simulation || !(functionName === 'batch' ? simulation.result[0] : simulation.result)) {
          log({ side, waiting: 'post-only quote would not rest' }); await cancelInstead(); if (state.pending) break; continue;
        }
        const gas = (await client.estimateContractGas({ address: m.engine, abi, functionName, args, account: account.address, blockNumber: block.number })) * 125n / 100n + 10000n;
        if (gas > 2_000_000n) {
          if (!repair) throw Error('MAKER_GAS_EXCEEDS_POLICY');
          log({ side, waiting: 'atomic repair gas ceiling', estimatedGas: gas });
          await cancelInstead(); if (state.pending) break; continue;
        }
        const [latest, pending, balance, canonical] = await Promise.all([
          client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
          client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
          client.getBalance({ address: account.address }), reads.getBlock({ blockNumber: block.number }),
        ]);
        if (latest !== pending) throw Error('MAKER_UNTRACKED_NONCE');
        if (balance < gas * 150_000_000_000n + 100_000_000_000_000_000n) { log({ side, waiting: 'maker gas wallet below policy minimum' }); continue; }
        if (canonical.hash !== block.hash) throw Error('MAKER_PREVIEW_NONCANONICAL');
        const fresh = await reads.getBlock();
        if (fresh.timestamp - source.lastObservedAt > 22n) { log({ side, waiting: 'source expired during preparation' }); continue; }
        const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc) });
        const request = await wallet.prepareTransactionRequest({ to: m.engine, data: encodeFunctionData({ abi, functionName, args }), gas, nonce: latest,
          maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n });
        // Recheck the short-lived hint after all owner-specific simulations,
        // fee/nonce/balance/source checks and request preparation. It authorizes
        // only skipping a second wait; the single durable outbox is unchanged.
        if (usePair && !pairedMaintenance.consume(pairInput)) {
          log({ side, waiting: 'paired maintenance window expired' }); continue;
        }
        const signedAt = Date.now();
        assertServiceNotRetired(privateDir + '/services');
        const raw = await wallet.signTransaction(request);
        state.pending = { hash: keccak256(raw), raw, side, epoch: epoch.toString(), tick, size: decision.size.toString(), functionName,
          ...(repair ? { action: 'epochRepair', cancelIds: [repair.orderId] } : {}) };
        save();
        pairedMaintenance.signed({ ...pairInput, hash: state.pending.hash,
          eligible: decision.reason === 'reprice' && !decision.repair, paired: usePair, now: signedAt });
        if (usePair) log({ pairedMaintenance: true, side, hash: state.pending.hash });
        await reconcile();
        if (state.pending) break;
        } catch (error) {
          const admission = !state.pending && retryableMakerAdmission(error);
          if (!admission) throw error;
          // Let the other owner repair an obsolete crossing quote on this same pass.
          log({ side, waiting: 'market changed before signing', reason: admission });
        }
      }
    } catch (error) {
      const admission = !state.pending && retryableMakerAdmission(error);
      if (admission) log({ waiting: 'market changed before signing', reason: admission });
      else {
        if (!transientServiceRead(error)) throw error;
        log({ retry: 'transient RPC failure', pending: !!state.pending });
      }
    }
    await wait(makerLoopDelay({ pending: !!state.pending, progressed }));
  }
  notifier.close();
  log({ stopped: true, pending: !!state.pending });
} catch (error) {
  const reason = error?.code === 'EEXIST' ? 'MAKER_JOURNAL_LOCKED'
    : /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'MAKER_RUNTIME_FAILURE';
  log({ fatal: reason, pending: !!state?.pending });
  throw Error(reason);
} finally {
  if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
