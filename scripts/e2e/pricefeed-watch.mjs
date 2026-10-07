/** Bounded local testnet publisher. Restart transient reads without clearing journals. */
import './source-dns.mjs';
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runMonadTestnetService, parseTestnetRunPolicy } from '../../packages/pricefeed/dist/src/monad-service.js';
import { recoverMonadNonce } from '../../packages/pricefeed/dist/src/monad-nonce-recovery.js';
import { recoverableUnsentReason } from '../../packages/pricefeed/dist/src/nonce-recovery-journal.js';
import { SampleCoordinator, indexFreshCutoff } from './sampler-coordination.mjs';
import { PacketStore, packetNamespace } from '../../packages/pricefeed/dist/src/packet-store.js';
import { publisherInitializationAfterFailure, transientPublisherFailure } from './publisher-restart-policy.mjs';

const [rpcFile, publicDir, privateDir, policyFile, evidenceFile, seconds = '5400', setup] = process.argv.slice(2);
if (!evidenceFile || !/^\d+$/.test(seconds) || +seconds < 1 || +seconds > 86400 || (setup !== undefined && setup !== '--initialize'))
  throw new Error('Usage: node pricefeed-watch.mjs <private-rpc.env> <public-service-dir> <private-service-dir> <policy.json> <evidence.jsonl> [seconds] [--initialize]');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rpcEnv = parseEnv(readFileSync(rpcFile, 'utf8'));
const rpcUrl = rpcEnv.MONAD_TESTNET_RPC;
const require = createRequire(new URL('../../packages/pricefeed/package.json', import.meta.url));
const { createPublicClient, http } = require('viem');
const finalityClient = createPublicClient({ transport: http(rpcUrl, { timeout: 5000, retryCount: 1 }) });
process.env.MONAD_READ_FALLBACK_URLS ||= rpcEnv.MONAD_READ_FALLBACK_URLS || '';
if (!rpcUrl) throw new Error('Private RPC env must contain MONAD_TESTNET_RPC');
const config = read(join(publicDir, 'pricefeed-config.json'));
const rules = read(join(publicDir, 'pricefeed-rules.json')), abi = read(join(publicDir, 'engine-abi.json'));
const policyInput = read(policyFile), policy = parseTestnetRunPolicy(policyInput);
const journalDirectory = resolve(privateDir, 'pricefeed-journals'), keysDirectory = resolve(privateDir, 'keys');
if (existsSync(join(privateDir, 'retired.json'))) throw new Error('RETIRED_PUBLICATION_SERVICE');
const end = Date.now() + +seconds * 1000, stop = new AbortController();
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
// Restore the soft deadline from verified, canonically finalized own evidence.
async function restoreFinalizedObservation() {
  if (!coordinator || !existsSync(join(journalDirectory, 'relay.sqlite'))) return;
  const db = new DatabaseSync(join(journalDirectory, 'relay.sqlite'), { readOnly: true });
  let latest = null;
  try {
    for (const row of db.prepare('SELECT body,sha256 FROM deliveries WHERE ns=?').all(packetNamespace(domain))) {
      if (createHash('sha256').update(row.body).digest('hex') !== row.sha256) throw Error('RELAY_JOURNAL_INTEGRITY');
      const delivery = JSON.parse(row.body);
      if (delivery.state === 'FINALIZED' && delivery.accepted && (!latest || BigInt(delivery.sequence) > BigInt(latest.sequence))) latest = delivery;
    }
  } finally { db.close(); }
  if (!latest) return;
  const [canonical, finalized] = await Promise.all([
    finalityClient.getBlock({ blockNumber: BigInt(latest.accepted.blockNumber) }),
    finalityClient.getBlock({ blockTag: 'finalized' }),
  ]);
  if (canonical.hash.toLowerCase() !== latest.accepted.blockHash.toLowerCase() || finalized.number < canonical.number) throw Error('PUBLICATION_RECEIPT_NONCANONICAL');
  const observation = finalizedObservation(BigInt(latest.sequence));
  if (packetReader.get(domain, observation.sequence).digest !== latest.digest) throw Error('FINALIZED_PACKET_MISMATCH');
  coordinator.notify({ ...observation, depthValid: latest.accepted.depthValid === true });
}
log({ started: true, pid: process.pid, engine: config.destination.engineAddress, source: config.mapping.externalMarketId, durationSeconds: +seconds });
try {
await restoreFinalizedObservation();
while (!stop.signal.aborted && Date.now() < end) {
  try {
    const result = await runMonadTestnetService({ config, rules, abi, rpcUrl, keysDirectory, journalDirectory, policy,
      durationSeconds: Math.max(1, Math.ceil((end - Date.now()) / 1000)), stopAfterFinalized: policy.budget.maxTransactions,
      initialize, publicationIntervalMs: 1000, minimumObservedAt: () => {
        const now = Date.now(), freshCutoff = indexFreshCutoff(now);
        // A bounded preference helps seal pending book captures; at the source
        // deadline INDEX immediately regains priority, even with a hung keeper.
        return coordinator?.getMinimumObservedAt(now, freshCutoff) ?? freshCutoff;
      } }, stop.signal, async result => {
      log({ state: result.state, reason: result.reason, sequence: result.sequence, hash: result.transactionHash, depthValid: result.depthValid });
      if (result.state === 'FINALIZED') { consecutiveFailures = 0; sample(result); }
      else if (result.state === 'MINED' && result.transactionHash) {
        // The pipeline reconciles MINED packets on its next pass without emitting
        // a second callback. Wait for canonical finality here so those packets
        // also trigger a book capture instead of skipping an entire interval.
        const deadline = Date.now() + 15_000;
        while (!stop.signal.aborted && Date.now() < deadline) {
          const [receipt, finalized] = await Promise.all([
            finalityClient.getTransactionReceipt({ hash: result.transactionHash }),
            finalityClient.getBlock({ blockTag: 'finalized' }),
          ]);
          if (receipt.status !== 'success') throw new Error('PUBLICATION_RECEIPT_REVERTED');
          if (finalized.number >= receipt.blockNumber) {
            if ((await finalityClient.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('PUBLICATION_RECEIPT_NONCANONICAL');
            sample(result); break;
          }
          await new Promise(r => setTimeout(r, 250));
        }
      }
    });
    log({ stopped: true, finalizedPackets: result.finalizedPackets, evidenceValid: result.evidenceValid }); break;
  } catch (error) {
    // Never log a provider exception or credential-bearing endpoint.
    const reason = error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? error.message : 'UNCLASSIFIED_SERVICE_FAILURE';
    log({ stoppedFor: reason });
    // A transient preflight failure can happen before any journal is created.
    // Retry that fresh start; once created, all five journals must be resumed.
    const files = ['source.sqlite', 'packets.sqlite', 'signer.sqlite', 'transactions.sqlite', 'relay.sqlite'];
    initialize = publisherInitializationAfterFailure(initialize, files.map(name => existsSync(join(journalDirectory, name))));
    if (stop.signal.aborted || Date.now() >= end) break;
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
      for (let attempt = 0; attempt < 3; attempt++) {
        const recovered = await recoverMonadNonce({ rpcUrl, config, abi, journalDirectory, keysDirectory, policy: policyInput,
          nonce: BigInt(p.nonce), originalHash: p.txHash, maxCostWei: 21_000n * policy.relay.maxFeePerGas, waitMs: 120_000,
          allowAttempted: p.attempts > 0 });
        log({ recovery: recovered.status, nonce: recovered.nonce, hash: recovered.hash });
        if (recovered.status === 'FINALIZED') break;
        if (attempt === 2) throw new Error('RECOVERY_STILL_PENDING');
      }
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
