/** Bounded local testnet publisher. Restart transient reads without clearing journals. */
import './source-dns.mjs';
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { runMonadTestnetService, parseTestnetRunPolicy } from '../../packages/pricefeed/dist/src/monad-service.js';
import { recoverMonadNonce } from '../../packages/pricefeed/dist/src/monad-nonce-recovery.js';
import { recoverableUnsentReason } from '../../packages/pricefeed/dist/src/nonce-recovery-journal.js';
import { SampleCoordinator, indexFreshCutoff } from './sampler-coordination.mjs';
import { PacketStore } from '../../packages/pricefeed/dist/src/packet-store.js';
import { publisherInitializationAfterFailure, transientPublisherFailure, recoverPublisherNonce, publisherBudgetExhausted } from './publisher-restart-policy.mjs';
import { serviceRuntime, transientServiceRead } from './service-runtime-policy.mjs';
import { assertServiceNotRetired } from './service-retirement.mjs';
import { writeNotice } from './readiness-notifier.mjs';

const [rpcFile, publicDir, privateDir, policyFile, evidenceFile, seconds = '5400', setup] = process.argv.slice(2);
if (!evidenceFile || !/^\d+$/.test(seconds) || +seconds < 1 || +seconds > 86400 || (setup !== undefined && setup !== '--initialize'))
  throw new Error('Usage: node pricefeed-watch.mjs <private-rpc.env> <public-service-dir> <private-service-dir> <policy.json> <evidence.jsonl> [seconds] [--initialize]');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rpcEnv = parseEnv(readFileSync(rpcFile, 'utf8'));
const rpcUrl = rpcEnv.MONAD_TESTNET_RPC;
process.env.MONAD_READ_FALLBACK_URLS ||= rpcEnv.MONAD_READ_FALLBACK_URLS || '';
process.env.MONAD_READ_RPC_CAPACITIES ||= rpcEnv.MONAD_READ_RPC_CAPACITIES || '';
if (!rpcUrl) throw new Error('Private RPC env must contain MONAD_TESTNET_RPC');
const config = read(join(publicDir, 'pricefeed-config.json'));
const rules = read(join(publicDir, 'pricefeed-rules.json')), abi = read(join(publicDir, 'engine-abi.json'));
const policyInput = read(policyFile), policy = parseTestnetRunPolicy(policyInput);
const journalDirectory = resolve(privateDir, 'pricefeed-journals'), keysDirectory = resolve(privateDir, 'keys');
assertServiceNotRetired(privateDir);
// Persistent operation removes only the wall-clock deadline. The existing
// cumulative transaction/cost policy and durable journals remain authoritative.
const runtime = serviceRuntime({ ...process.env, EROS_SERVICE_DURATION_SECONDS: seconds }, seconds, Date.now(), 1);
const end = runtime.end, stop = new AbortController();
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
const log = (value) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value }, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  appendFileSync(evidenceFile, line + '\n', { mode: 0o600 }); console.log(line);
};
let recoveries = 0, consecutiveFailures = 0;
let initialize = setup === '--initialize';
const coordination = process.env.EROS_PRICE_COORDINATION_DIR;
if (coordination && !coordination.startsWith('tmp/')) throw new Error('Coordination files must stay in ignored tmp');
const domain = { chainId: BigInt(config.destination.chainId), engine: config.destination.engineAddress,
  marketId: config.destination.marketId, sourceId: config.destination.sourceId,
  rulesHash: config.destination.sourceRulesHash, signer: config.destination.signerAddress };
let packetReader;
const finalizedObservation = sequence => {
  packetReader ??= new PacketStore(join(journalDirectory, 'packets.sqlite'), true);
  const saved = packetReader.get(domain, sequence);
  if (!saved?.signature || saved.state !== 'SIGNED') throw Error('FINALIZED_PACKET_MISSING');
  return { sequence, observedAt: saved.packet.observation.observedAt };
};
const coordinator = coordination ? new SampleCoordinator({
  engine: config.destination.engineAddress, signal: stop.signal,
  readRequest: () => existsSync(join(coordination, 'sample-request.json')) ? read(join(coordination, 'sample-request.json')) : null,
  readAck: () => existsSync(join(coordination, 'sample-ack.json')) ? read(join(coordination, 'sample-ack.json')) : null,
  readStatus: () => existsSync(join(coordination, 'sampler-status.json')) ? read(join(coordination, 'sampler-status.json')) : null,
  writeRequest: request => {
    const path = join(coordination, 'sample-request.json');
    writeFileSync(path + '.tmp', JSON.stringify(request), { mode: 0o600 }); renameSync(path + '.tmp', path);
  },
  onResult: result => log({ sample: result.outcome, sequence: result.sequence, sampledAt: result.capture?.observedAt ?? null }),
  onError: () => log({ sample: 'COORDINATION_FAILED', independentIndex: true }),
}) : null;
const sample = result => coordinator?.notify({ ...finalizedObservation(result.sequence), depthValid: result.depthValid === true });
log({ started: true, pid: process.pid, engine: config.destination.engineAddress, source: config.mapping.externalMarketId, mode: runtime.mode, durationSeconds: +seconds });
try {
while (!stop.signal.aborted && Date.now() < end) {
  try {
    assertServiceNotRetired(privateDir);
    const result = await runMonadTestnetService({ config, rules, abi, rpcUrl, keysDirectory, journalDirectory, policy,
      durationSeconds: Math.min(86400, Math.max(1, Math.ceil((end - Date.now()) / 1000))), stopAfterFinalized: policy.budget.maxTransactions,
      initialize, publicationIntervalMs: 1000, minimumObservedAt: () => {
        const now = Date.now(), freshCutoff = indexFreshCutoff(now);
        // A bounded preference helps seal pending book captures; at the source
        // deadline INDEX immediately regains priority, even with a hung keeper.
        return coordinator?.getMinimumObservedAt(now, freshCutoff) ?? freshCutoff;
      } }, stop.signal, async result => {
      log({ state: result.state, reason: result.reason, sequence: result.sequence, hash: result.transactionHash, depthValid: result.depthValid });
      if (result.state === 'FINALIZED') {
        consecutiveFailures = 0;
        // Wake-up hint for the maker; publication never depends on it.
        try { writeNotice(coordination, 'index-notice.json', { engine: config.destination.engineAddress, sequence: String(result.sequence), at: Date.now() }); }
        catch { log({ notice: 'INDEX_NOTICE_WRITE_FAILED' }); }
        sample(result);
      }
      // The durable pipeline emits canonical finality, including delayed receipts
      // and replay after service restart. No bounded wait may discard that event.
    });
    const budgetExhausted = publisherBudgetExhausted(result);
    log({ stopped: true, finalizedPackets: result.finalizedPackets, evidenceValid: result.evidenceValid,
      reason: budgetExhausted ? 'publication-budget-exhausted' : stop.signal.aborted ? 'shutdown' : 'session-ended' });
    if (budgetExhausted && runtime.mode === 'persistent') process.exitCode = 78;
    if (runtime.mode !== 'persistent' || stop.signal.aborted || budgetExhausted) break;
    initialize = false;
  } catch (error) {
    // Never log a provider exception or credential-bearing endpoint.
    const reason = error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? error.message : 'UNCLASSIFIED_SERVICE_FAILURE';
    log({ stoppedFor: reason });
    // A transient preflight failure can happen before any journal is created.
    // Retry that fresh start; once created, all five journals must be resumed.
    const files = ['source.sqlite', 'packets.sqlite', 'signer.sqlite', 'transactions.sqlite', 'relay.sqlite'];
    initialize = publisherInitializationAfterFailure(initialize, files.map(name => existsSync(join(journalDirectory, name))));
    if (stop.signal.aborted || Date.now() >= end) break;
    if (transientServiceRead(error)) {
      // The closed service's next startup reconciles its same durable outbox.
      // Pool failover never resets source sequence, signing state or cost limits.
      log({ retry: 'read pool temporarily unavailable' });
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    if (initialize) {
      if (!transientPublisherFailure(reason) || ++consecutiveFailures > 5) throw new Error(reason);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    const db = new DatabaseSync(join(journalDirectory, 'relay.sqlite'), { readOnly: true });
    let pending;
    try {
      pending = db.prepare('SELECT body FROM deliveries').all().map(r => JSON.parse(r.body))
        .filter(r => r.state === 'QUARANTINED');
    } finally { db.close(); }
    if (reason === 'MONAD_SENDER_NEEDS_TEST_MON' && pending.length === 0) {
      // Keep the original journal set while an operator funds this gas wallet.
      // Resuming rechecks its balance and reconciles any existing delivery first.
      log({ waiting: 'publisher gas wallet below policy minimum' });
      await new Promise(r => setTimeout(r, 15_000));
      continue;
    }
    if (pending.length === 1 && recoveries < 3 && pending[0].attempts <= policy.relay.maxAttempts && pending[0].accepted === null
      && pending[0].raw && recoverableUnsentReason(pending[0].reason)) {
      // The recovery implementation revalidates expiry, signatures, immutable
      // identity, every canonical receipt, sender nonce and cumulative budget.
      const p = pending[0]; recoveries++;
      await new Promise(r => setTimeout(r, 31_000));
      await recoverPublisherNonce({ signal: stop.signal, deadline: end,
        recover: () => recoverMonadNonce({ rpcUrl, config, abi, journalDirectory, keysDirectory, policy: policyInput,
          nonce: BigInt(p.nonce), originalHash: p.txHash, maxCostWei: 21_000n * policy.relay.maxFeePerGas, waitMs: 120_000,
          allowAttempted: p.attempts > 0 }),
        onResult: recovered => log({ recovery: recovered.status, nonce: recovered.nonce, hash: recovered.hash }),
      });
    } else {
      if (!transientPublisherFailure(reason) || pending.length || ++consecutiveFailures > 5) throw new Error(reason);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

} finally {
  await coordinator?.close();
  packetReader?.close();
}
