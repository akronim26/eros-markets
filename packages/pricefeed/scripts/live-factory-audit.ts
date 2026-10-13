import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, decodeFunctionData, http, keccak256, parseTransaction, recoverAddress, stringToHex,
  recoverTransactionAddress, type Abi, type Hex, type TransactionSerialized } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { parseConfig } from '../src/config.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { PacketStore, type PacketDomain } from '../src/packet-store.js';
import { observationDigest, submitCalldata } from '../src/wire.js';
import { validateReceipt } from '../src/receipts.js';
import { requireLoopback } from './local-factory-fixture.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const names = ['source.sqlite', 'packets.sqlite', 'signer.sqlite', 'transactions.sqlite', 'relay.sqlite'];
export async function auditLiveFactory(rpc: string, abiPath: string, directory: string, reportPath: string, output: string): Promise<void> {
  requireLoopback(rpc); if (existsSync(output)) throw new Error('LIVE_AUDIT_OUTPUT_ALREADY_EXISTS');
  directory = resolve(directory);
  const identity = JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8'));
  const run = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(run.mode, 'LOCAL_LIVE_SOURCE_FULL_ENGINE'); assert.equal(run.completed, true, 'live publisher must stop cleanly before audit');
  const config = parseConfig(identity.config), d = config.destination!;
  const artifact = JSON.parse(readFileSync(abiPath, 'utf8')), abi: Abi = Array.isArray(artifact) ? artifact : artifact.abi;
  assert.equal(keccak256(stringToHex(JSON.stringify(abi))), d.abiHash);
  assert.equal(run.engine, d.engineAddress); assert.equal(run.engineCodeHash, d.engineCodeHash);
  assert.equal(run.marketId, d.marketId); assert.equal(run.chainId, 31337);
  assert.equal(run.clockWarps, 0); assert.equal(run.actualSourceTimes, true);
  const domain: PacketDomain = { chainId: 31337n, engine: d.engineAddress, marketId: d.marketId, sourceId: d.sourceId,
    rulesHash: d.sourceRulesHash, signer: d.signerAddress };
  const client = createPublicClient({ transport: http(rpc, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }), cacheTime: 0 });
  assert.equal(await client.getChainId(), 31337);
  const checkpoint = await client.getBlock({ blockNumber: BigInt(run.readiness.blockNumber) });
  assert.equal(checkpoint.hash, run.readiness.blockHash);
  let finalized = await client.getBlock({ blockTag: 'finalized' });
  const finalityDeadline = Date.now() + 30000;
  while (finalized.number < checkpoint.number && Date.now() < finalityDeadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    finalized = await client.getBlock({ blockTag: 'finalized' });
  }
  assert.ok(finalized.number >= checkpoint.number, 'closed run checkpoint must become finalized on the ordinary local clock');
  assert.equal(keccak256((await client.getCode({ address: d.engineAddress as Hex, blockNumber: checkpoint.number }))!), d.engineCodeHash);
  const inventory = Object.fromEntries(names.map(name => [name, sha(readFileSync(join(directory, name)))]));
  for (const name of names) {
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try { assert.deepEqual(Object.values(db.prepare('PRAGMA integrity_check').get()!), ['ok']); } finally { db.close(); }
  }
  const source = new Journal(join(directory, 'source.sqlite'), true), packets = new PacketStore(join(directory, 'packets.sqlite'), true);
  const relay = new DatabaseSync(join(directory, 'relay.sqlite'), { readOnly: true });
  const signing = new DatabaseSync(join(directory, 'signer.sqlite'), { readOnly: true });
  const transactions = new DatabaseSync(join(directory, 'transactions.sqlite'), { readOnly: true });
  const publisher = privateKeyToAccount(('0x' + '22'.repeat(32)) as Hex).address;
  const sampler = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 11 }).address;
  try {
    assert.equal(source.verify(), true); assert.equal(packets.verify(), true);
    const deliveries = new Map(relay.prepare('SELECT body,sha256 FROM deliveries').all().map(row => {
      assert.equal(sha(String(row.body)), row.sha256); const body = JSON.parse(String(row.body)); return [String(body.sequence), body];
    }));
    const signatures = new Map(signing.prepare('SELECT * FROM signer_reservations').all().map(row => {
      assert.equal(sha(`${row.identity}:${row.digest}:${row.signature ?? ''}`), row.sha256); return [String(row.sequence), row];
    }));
    const rawTransactions = new Map(transactions.prepare('SELECT * FROM transaction_reservations').all().map(row => {
      assert.equal(sha(`${row.request}:${row.raw ?? ''}:${row.tx_hash ?? ''}`), row.sha256); return [String(row.nonce), row];
    }));
    const accepted = [], publisherReceipts = [], seen = new Set<string>(); let previousSequence = 0n, previousSource = 0n;
    for (const item of packets.list(domain)) {
      const packet = item.packet, delivery = deliveries.get(packet.observation.sequence.toString());
      if (!delivery) { assert.equal(item.state, 'EXPIRED'); continue; }
      assert.ok(['MINED', 'FINALIZED'].includes(delivery.state), `unresolved delivery ${delivery.state}`);
      const hash = delivery.txHash as Hex, raw = delivery.raw as Hex;
      assert.equal(keccak256(raw), hash); assert.ok(!seen.has(hash)); seen.add(hash);
      assert.equal(observationDigest(packet.observation, 31337n, d.engineAddress), item.digest);
      assert.ok(item.signature); assert.equal((await recoverAddress({ hash: item.digest, signature: item.signature })).toLowerCase(), d.signerAddress.toLowerCase());
      assert.equal(signatures.get(packet.observation.sequence.toString())?.signature, item.signature);
      assert.equal(rawTransactions.get(String(delivery.nonce))?.raw, raw);
      assert.equal((await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase(), publisher.toLowerCase());
      const tx = parseTransaction(raw); assert.equal(tx.chainId, 31337); assert.equal(tx.to?.toLowerCase(), d.engineAddress.toLowerCase());
      assert.equal(tx.value ?? 0n, 0n); assert.equal(tx.data, submitCalldata(packet.observation, item.signature));
      assert.equal(tx.nonce, Number(delivery.nonce)); assert.ok(tx.gas && tx.gas <= 30000000n);
      const receipt = await client.getTransactionReceipt({ hash });
      const mined = await client.getBlock({ blockNumber: receipt.blockNumber });
      assert.ok(finalized.number >= mined.number); assert.equal(receipt.blockHash, mined.hash);
      const result = validateReceipt(packet, hash, { ...receipt, logs: receipt.logs.map(log => ({ ...log,
        blockHash: log.blockHash!, blockNumber: log.blockNumber!, transactionHash: log.transactionHash!, logIndex: log.logIndex! })) },
        { number: mined.number, hash: mined.hash, timestamp: mined.timestamp },
        { depthNLots: BigInt(config.pricing.depthNLots), maxSpreadWad: BigInt(config.pricing.maxSpreadWad) });
      assert.ok(packet.observation.sequence > previousSequence && packet.sourceMs >= previousSource);
      previousSequence = packet.observation.sequence; previousSource = packet.sourceMs;
      accepted.push({ ...item, delivery, accepted: result });
      publisherReceipts.push({ hash, blockNumber: mined.number, blockHash: mined.hash, timestamp: mined.timestamp,
        gasUsed: receipt.gasUsed, gasLimit: tx.gas, status: receipt.status });
    }
    assert.ok(accepted.length > 0, 'no accepted real observations');
    const samplerReceipts = [];
    for (const entry of run.sampleReceipts as { hash: Hex }[]) {
      assert.ok(!seen.has(entry.hash)); seen.add(entry.hash);
      const receipt = await client.getTransactionReceipt({ hash: entry.hash });
      const tx = await client.getTransaction({ hash: entry.hash });
      const mined = await client.getBlock({ blockNumber: receipt.blockNumber });
      assert.equal(receipt.status, 'success'); assert.equal(receipt.blockHash, mined.hash); assert.ok(finalized.number >= mined.number);
      assert.equal(tx.from.toLowerCase(), sampler.toLowerCase()); assert.equal(tx.to?.toLowerCase(), d.engineAddress.toLowerCase());
      assert.equal(tx.value, 0n); assert.ok(tx.gas <= 30000000n); assert.equal(decodeFunctionData({ abi, data: tx.input }).functionName, 'samplePerp');
      samplerReceipts.push({ hash: entry.hash, blockNumber: mined.number, blockHash: mined.hash, timestamp: mined.timestamp,
        gasUsed: receipt.gasUsed, gasLimit: tx.gas, status: receipt.status });
    }
    const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: d.engineAddress as Hex,
      abi, functionName, args, blockNumber: checkpoint.number });
    const [twap, perp, basis, risk, activeProfile] = await Promise.all([
      read('indexTwap300', [checkpoint.timestamp]), read('perpTwap60', [checkpoint.timestamp]),
      read('basisTwap900', [checkpoint.timestamp]), read('marketRiskView'), read('activeProfile'),
    ]);
    assert.deepEqual(JSON.parse(json(twap)), run.readiness.index);
    assert.deepEqual(JSON.parse(json(perp)), run.readiness.perp);
    assert.deepEqual(JSON.parse(json(basis)), run.readiness.basis);
    const report = { mode: 'LOCAL_LIVE_FACTORY_PRICEFEED_AUDIT', passed: true, chainId: 31337,
      config, sourceRules: identity.sourceRules, archive: directory, archiveSha256: inventory,
      checkpoint: { number: checkpoint.number, hash: checkpoint.hash, timestamp: checkpoint.timestamp },
      actualIndexTwap: twap, actualPerpTwap: perp, actualBasisTwap: basis, risk, activeProfile, accepted, publisherReceipts, samplerReceipts,
      publisherReceiptCount: publisherReceipts.length, samplerReceiptCount: samplerReceipts.length,
      signaturesVerified: true, canonicalReceiptsVerified: true, externalChainTransactions: 0, productionApproved: false };
    writeFileSync(output, json(report) + '\n', { flag: 'wx' });
    console.log(json({ passed: true, publisherReceipts: publisherReceipts.length, samplerReceipts: samplerReceipts.length, output }));
  } finally { transactions.close(); signing.close(); relay.close(); packets.close(); source.close(); }
}
