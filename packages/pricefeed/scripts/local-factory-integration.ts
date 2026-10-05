import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPublicClient, defineChain, http, keccak256, parseAbi, stringToHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Journal } from '../src/journal.js';
import { PacketStore, type PacketDomain } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalTransactionSigner } from '../src/local-transaction-signer.js';
import { LocalRelay, type RelayPolicy } from '../src/local-relay.js';
import { localRpcTransport } from '../src/local-rpc.js';
import { LocalPipeline, type PipelineResult } from '../src/pipeline.js';
import { parseConfig, type MarketConfig } from '../src/config.js';
import { Worker } from '../src/worker.js';
import { json } from '../src/math.js';
import { observationDigest } from '../src/wire.js';
import { expectedDemoTwap } from './demo-packet.js';
import { withLocalSamplingLock } from './local-sampling-lock.js';
import { LOCAL_MARKETS, localFactoryFixture, requireLoopback, startFixtureSource, type LocalMarket } from './local-factory-fixture.js';

const TWAP_ABI = parseAbi(['function indexTwap300(uint64) view returns ((bool available,int256 twapWad,uint256 coveredSecs,int256 integral))']);
const SOURCE_ABI = parseAbi(['function sourceState(bytes32) view returns ((address signer,bytes32 rulesHash,uint64 lastSequence,uint64 lastObservedAt,bool configured))']);
const HALT_ABI = parseAbi(['function halted() view returns (bool)']);

function argumentsMap(): Map<string, string> {
  const result = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !value || result.has(name) || !['--mode', '--scheduled-t', '--rpc', '--manifest', '--fixture', '--abi', '--directory', '--output'].includes(name)) {
      throw new Error('BAD_LOCAL_FACTORY_ARGUMENTS');
    }
    result.set(name, value);
  }
  return result;
}

async function main() {
  const args = argumentsMap();
  const required = (name: string) => { const value = args.get(name); if (!value) throw new Error(`MISSING_${name}`); return value; };
  const mode = required('--mode');
  const output = resolve(required('--output'));
  mkdirSync(dirname(output), { recursive: true });
  if (mode === 'prepare') {
    const fixture = localFactoryFixture(BigInt(required('--scheduled-t')));
    writeFileSync(output, json(fixture) + '\n');
    console.log(json({ mode, output, chainId: 31337, productionApproved: false })); return;
  }
  if (!['verify', 'refresh', 'warmup', 'mature', 'watch'].includes(mode)) throw new Error('UNKNOWN_LOCAL_FACTORY_MODE');
  let activeMarkets: readonly LocalMarket[] = LOCAL_MARKETS;
  const endpoint = required('--rpc'); requireLoopback(endpoint);
  const chain = defineChain({ id: 31337, name: 'Local integrated Eros fixture', nativeCurrency: { name: 'Test Ether', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [endpoint] } } });
  const client = createPublicClient({ chain, transport: http(endpoint, { retryCount: 0, timeout: 5000, fetchOptions: { redirect: 'error' } }), cacheTime: 0 });
  assert.equal(await client.getChainId(), 31337, 'LOCAL_CHAIN_31337_REQUIRED');
  const clientVersion = await client.request({ method: 'web3_clientVersion' });
  assert.match(clientVersion.toLowerCase(), /anvil/, 'OWNED_ANVIL_REQUIRED');
  const fixtureFile = JSON.parse(readFileSync(required('--fixture'), 'utf8')) as ReturnType<typeof localFactoryFixture>;
  const fixture = localFactoryFixture(BigInt(fixtureFile.scheduledT));
  assert.deepEqual(fixtureFile, fixture, 'FIXTURE_MANIFEST_CHANGED');
  const manifest = JSON.parse(readFileSync(required('--manifest'), 'utf8')) as {
    chainId: number; riskScenario?: string; markets: Record<LocalMarket, { engine: Hex; marketId: string; scheduledT: string | number }>;
  };
  assert.equal(Number(manifest.chainId), 31337, 'WRONG_MANIFEST_CHAIN');
  const artifact = JSON.parse(readFileSync(required('--abi'), 'utf8')) as { abi: Abi } | Abi;
  const abi: Abi = Array.isArray(artifact) ? artifact : (artifact as { abi: Abi }).abi;
  const directory = resolve(required('--directory')); mkdirSync(directory, { recursive: true });
  const samplingLock = manifest.riskScenario === 'leveraged-fixture' ? join(dirname(directory), 'sampling.lock') : undefined;
  let clock = (await client.getBlock()).timestamp * 1000n;
  const now = () => clock;
  const halted = (market: LocalMarket) => client.readContract({ address: manifest.markets[market].engine,
    abi: HALT_ABI, functionName: 'halted' });
  assert.equal(await halted('demo'), false, 'LOCAL_DEMO_ALREADY_HALTED');
  assert.ok(clock / 1000n < BigInt(fixture.scheduledT), 'LOCAL_DEMO_HALT_DEADLINE_REACHED');
  if (['refresh', 'warmup', 'mature'].includes(mode) && await halted('terminal')) activeMarkets = ['demo'];
  const configurations = {} as Record<LocalMarket, MarketConfig>;
  const domains = {} as Record<LocalMarket, PacketDomain>;
  for (const market of LOCAL_MARKETS) {
    const deployment = manifest.markets[market]; const fixtureMarket = fixture.markets[market];
    assert.equal(deployment.marketId.toLowerCase(), fixtureMarket.marketId.toLowerCase());
    assert.equal(String(deployment.scheduledT), fixture.scheduledT);
    const code = await client.getBytecode({ address: deployment.engine });
    assert.ok(code && code !== '0x', 'MISSING_FACTORY_ENGINE');
    const listing = await client.readContract({ address: deployment.engine, abi, functionName: 'listing' }) as {
      listedAt: bigint; invalidRule: { captureGraceSecs: bigint; voidSecs: bigint; fallbackListed: boolean; fallbackPriceWad: bigint };
    };
    configurations[market] = parseConfig({ ...fixtureMarket.config, destination: {
      chainId: '31337', engineAddress: deployment.engine, engineCodeHash: keccak256(code),
      abiHash: keccak256(stringToHex(JSON.stringify(abi))), marketId: deployment.marketId,
      sourceId: fixture.sourceId, sourceRulesHash: fixtureMarket.sourceRulesHash, signerAddress: fixture.indexSigner,
      listedAt: String(listing.listedAt), scheduledT: fixture.scheduledT,
      invalidRule: { captureGraceSecs: String(listing.invalidRule.captureGraceSecs), voidSecs: String(listing.invalidRule.voidSecs),
        fallbackListed: listing.invalidRule.fallbackListed, fallbackPriceWad: String(listing.invalidRule.fallbackPriceWad) },
    } });
    domains[market] = { chainId: 31337n, engine: deployment.engine, marketId: deployment.marketId,
      sourceId: fixture.sourceId, rulesHash: fixtureMarket.sourceRulesHash, signer: fixture.indexSigner };
  }
  const policy: RelayPolicy = { gasCap: 2000000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
    maxCostWei: 4000000000000000n, headroomMs: 1000n, confirmations: 1n, timeoutMs: 5000, maxAttempts: 3, leaseMs: 60000n };
  const source = await startFixtureSource(now);
  const results: PipelineResult[] = [];
  const report: Record<string, unknown> = { schemaVersion: 1, mode: 'LOCAL_HTTP_FIXTURE_REAL_FACTORY_ENGINE', operation: mode,
    chainId: 31337, fullEconomicEngine: true, externalChainTransactions: 0, paidApiCalls: 0, productionApproved: false,
    timeModel: mode === 'watch' ? 'FIVE_SECOND_POLL_OF_LOCAL_CHAIN_CLOCK_SYNTHETIC_SOURCE' : 'CONTROLLED_ANVIL_TIMESTAMP_ADVANCES_NOT_WALL_CLOCK_LATENCY',
    sourceEndpoint: source.endpoint, activeMarkets,
    manifest: resolve(required('--manifest')), fixture: resolve(required('--fixture')), journalDirectory: directory,
    configurations, results, completed: false };
  const save = () => writeFileSync(output, json(report) + '\n');
  let journal: Journal | undefined; let packets: PacketStore | undefined; let transactionSigner: LocalTransactionSigner | undefined;
  let relay: LocalRelay | undefined; let pipeline: LocalPipeline | undefined;
  let workers = {} as Record<LocalMarket, Worker>; let signers: LocalTestSigner[] = [];
  const transport = () => {
    const base = localRpcTransport(endpoint, abi, transactionSigner);
    return { ...base, simulate: async (to: string, data: Hex) => {
      assert.equal(await client.getChainId(), 31337);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const block = await client.getBlock();
          await client.call({ account: base.sender as Hex, to: to as Hex, data, blockNumber: block.number });
          return;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('Required data unavailable') || attempt === 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } };
  };
  const close = () => {
    pipeline?.close(); for (const worker of Object.values(workers)) worker.releaseLease(); relay?.close();
    for (const signer of signers) signer.close(); transactionSigner?.close(); packets?.close(); journal?.close();
    pipeline = undefined; relay = undefined; transactionSigner = undefined; packets = undefined; journal = undefined;
    signers = []; workers = {} as Record<LocalMarket, Worker>;
  };
  const open = async () => {
    journal = new Journal(join(directory, 'source.sqlite')); packets = new PacketStore(join(directory, 'packets.sqlite'));
    transactionSigner = new LocalTransactionSigner(join(directory, 'transactions.sqlite'), !existsSync(join(directory, 'transactions.sqlite')));
    relay = new LocalRelay(join(directory, 'relay.sqlite'), packets, transport(), policy, now);
    const entries = activeMarkets.map(market => {
      const signer = new LocalTestSigner(join(directory, 'signer.sqlite'), domains[market], packets!, now); signers.push(signer);
      const worker = new Worker(configurations[market], source.provider(market), journal!, randomUUID(), now); workers[market] = worker;
      return { worker, signer, rules: fixture.markets[market].rules };
    });
    pipeline = new LocalPipeline(entries, packets, relay, transport(), policy, now);
    await pipeline.start();
  };
  const advance = async (seconds: number) => {
    const latest = await client.getBlock();
    if (mode === 'mature') {
      const epoch = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'epoch', blockNumber: latest.number }) as readonly [bigint, bigint, bigint, ...unknown[]];
      const risk = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'marketRiskView', blockNumber: latest.number }) as { accountingState: number };
      // Let the actual maintenance transactions finish within the normal freshness
      // window. Artificial clock jumps during rollover would deliberately stale it.
      if (risk.accountingState !== 0 || latest.timestamp + 60n >= epoch[2]) {
        clock = latest.timestamp * 1000n; pipeline?.renew(); return;
      }
    }
    const timestamp = latest.timestamp + BigInt(seconds);
    await client.request({ method: 'evm_setNextBlockTimestamp' as never, params: [Number(timestamp)] as never });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    clock = timestamp * 1000n; pipeline?.renew();
  };
  const processAll = async () => {
    const output: PipelineResult[] = [];
    for (const market of activeMarkets) {
      const snapshot = await workers[market].poll();
      let result = await pipeline!.process(snapshot);
      for (let attempt = 0; result.state === 'EXPIRED' && attempt < 3; attempt += 1) {
        results.push(result); result = await pipeline!.process(snapshot);
      }
      for (let attempt = 0; result.state === 'UNKNOWN' && result.sequence !== null && attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const delivery = await relay!.reconcile(configurations[market], result.sequence);
        if (delivery.state === 'MINED' || delivery.state === 'FINALIZED') result = await pipeline!.process(snapshot);
      }
      results.push(result); output.push(result);
      if (results.length > 512) results.shift();
    }
    save(); return output;
  };
  const accepted = (market: LocalMarket) => packets!.list(domains[market]).filter(packet => relay!.get(domains[market], packet.packet.observation.sequence)?.accepted);
  const immutable = () => LOCAL_MARKETS.flatMap(market => packets!.list(domains[market]).map(packet => ({
    market, packet: packet.packet, digest: packet.digest, signature: packet.signature,
    raw: relay!.get(domains[market], packet.packet.observation.sequence)?.raw ?? null,
    nonce: relay!.get(domains[market], packet.packet.observation.sequence)?.nonce ?? null,
  })));
  const assertDelivered = (entries: PipelineResult[]) => {
    for (const result of entries) assert.ok(['MINED', 'FINALIZED'].includes(result.state), json(result));
  };
  const publishAdvanced = (seconds: number) => withLocalSamplingLock(samplingLock, async () => {
    await advance(seconds); assertDelivered(await processAll());
  });
  const twapCheck = async (requireAvailable: boolean) => {
    const block = await client.getBlock();
    const checks = {} as Record<string, unknown>;
    for (const market of activeMarkets) {
      const actual = await client.readContract({ address: manifest.markets[market].engine, abi: TWAP_ABI,
        functionName: 'indexTwap300', args: [block.timestamp], blockNumber: block.number });
      const expected = expectedDemoTwap(accepted(market).map(packet => {
        const receipt = relay!.get(domains[market], packet.packet.observation.sequence)!.accepted!;
        return { t: packet.packet.observation.observedAt, price: receipt.priceWad, valid: receipt.depthValid };
      }), block.timestamp);
      assert.deepEqual(actual, expected);
      assert.equal(actual.available, requireAvailable, `${market}: unexpected coverage`);
      checks[market] = { actual, expected, block: block.number, timestamp: block.timestamp, verified: true };
    }
    return checks;
  };
  try {
    await client.request({ method: 'anvil_setBalance' as never, params: [transport().sender, '0x56BC75E2D63100000'] as never });
    await open();
    if (mode === 'watch') {
      let stopped = false;
      const stop = () => { stopped = true; };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      report.running = true; save();
      console.log('LOCAL CONTROLLED FIXTURE ONLY: publishing synthetic 0.5 INDEX to unhalted fixture engines, no public data or credentials.');
      try {
        while (!stopped && !existsSync(join(directory, 'stop-watcher'))) {
          await withLocalSamplingLock(samplingLock, async () => {
            clock = (await client.getBlock()).timestamp * 1000n;
            if (await halted('demo') || clock / 1000n >= BigInt(fixture.scheduledT)) throw new Error('LOCAL_DEMO_HALTED_PUBLISHER_STOPPED');
            activeMarkets = await halted('terminal') ? ['demo'] : LOCAL_MARKETS;
            report.activeMarkets = activeMarkets;
            pipeline!.renew(); assertDelivered(await processAll());
            report.lastPublishedAt = clock; save();
          });
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); report.running = false;
      }
    } else {
      await publishAdvanced(1);
    }
    if (mode === 'warmup') {
      for (let checkpoint = 0; checkpoint <= 31; checkpoint += 1) {
        await publishAdvanced(10);
      }
      report.fullWindow = await twapCheck(true);
    }
    if (mode === 'mature') {
      await withLocalSamplingLock(samplingLock, async () => {
        const head = await client.getBlock();
        const epoch = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'epoch', blockNumber: head.number }) as readonly [bigint, bigint, bigint, ...unknown[]];
        const risk = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'marketRiskView', blockNumber: head.number }) as { pricingMode: number };
        const target = epoch[2] - 1500n;
        if (risk.pricingMode === 0 && target > head.timestamp) {
          // Skip idle fixture time, then rebuild every real window and wait for
          // an eligible epoch opening. No observations are fabricated.
          const history = immutable();
          close();
          await advance(Number(target - head.timestamp));
          await open();
          assert.deepEqual(immutable(), history, 'CLOCK_ALIGNMENT_CHANGED_IMMUTABLE_HISTORY');
          report.maturityClockStart = { before: head.timestamp, requested: target, observed: (await client.getBlock()).timestamp };
        }
      });
      let ready = false;
      for (let checkpoint = 0; checkpoint < 600; checkpoint += 1) {
        await publishAdvanced(10);
        // Inspect after the independent sampler can publish, not immediately
        // after an artificial clock advance momentarily ages its prior sample.
        await new Promise(resolve => setTimeout(resolve, 3000));
        const head = await client.getBlock();
        const risk = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'marketRiskView', blockNumber: head.number }) as { markAvailable: boolean };
        const caps = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'leverageCaps', blockNumber: head.number }) as [bigint, bigint];
        const epoch = await client.readContract({ address: manifest.markets.demo.engine, abi, functionName: 'epoch', blockNumber: head.number }) as readonly [bigint, bigint, bigint, ...unknown[]];
        assert.equal((await client.getBlock({ blockNumber: head.number })).hash, head.hash, 'LEVERAGE_READINESS_REORGED');
        // Require a whole BASIS window in the current epoch, rather than the
        // short carry of pre-roll samples before the fixture owners re-quote.
        if (risk.markAvailable && caps[0] === 5n && caps[1] === 5n && head.timestamp >= epoch[1] + 900n) {
          report.leverageReadiness = { risk, caps, epochId: epoch[0], epochStart: epoch[1], blockNumber: head.number, blockHash: head.hash, timestamp: head.timestamp, controlledTime: true };
          ready = true; break;
        }
      }
      assert.ok(ready, 'REAL_SAMPLER_AND_EPOCH_DID_NOT_REACH_LEVERAGE_READINESS');
    }
    if (mode === 'verify') {
      const snapshots = immutable(); close(); await open();
      assert.deepEqual(immutable(), snapshots, 'RESTART_CHANGED_IMMUTABLE_HISTORY');
      await advance(10); assertDelivered(await processAll());
      for (const item of snapshots) assert.ok(immutable().some(candidate => json(candidate) === json(item)));
      report.restart = { kind: 'GRACEFUL_ALL_FIVE_JOURNALS_REOPEN', preservedPackets: snapshots.length, verified: true };
      const signerAccount = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex);
      const wrongAccount = privateKeyToAccount(('0x' + '33'.repeat(32)) as Hex);
      const adversarial: Record<string, unknown>[] = [];
      for (const market of LOCAL_MARKETS) {
        const domain = domains[market]; const engine = manifest.markets[market].engine;
        const latest = accepted(market).at(-1)!; const observation = latest.packet.observation;
        const next = { ...observation, sequence: observation.sequence + 1n };
        const backwards = { ...next, observedAt: observation.observedAt - 1n };
        const future = { ...next, publishedAt: (await client.getBlock()).timestamp + 1000n };
        const cases = [
          { name: 'wrong-signer', observation: next, signature: await wrongAccount.sign({ hash: observationDigest(next, 31337n, engine) }), error: 'BadSignature' },
          { name: 'wrong-chain-domain', observation: next, signature: await signerAccount.sign({ hash: observationDigest(next, 10143n, engine) }), error: 'BadSignature' },
          { name: 'replay', observation, signature: latest.signature!, error: 'DuplicateOrOldSequence' },
          { name: 'backwards-source-time', observation: backwards, signature: await signerAccount.sign({ hash: observationDigest(backwards, 31337n, engine) }), error: 'BackwardsObservation' },
          { name: 'future-publication', observation: future, signature: await signerAccount.sign({ hash: observationDigest(future, 31337n, engine) }), error: 'FutureTimestamp' },
        ];
        const before = await transport().identity(domain);
        for (const candidate of cases) {
          await assert.rejects(client.simulateContract({ address: engine, abi, functionName: 'submitObservation',
            args: [candidate.observation, candidate.signature], account: transport().sender as Hex }), new RegExp(candidate.error));
          adversarial.push({ market, case: candidate.name, expectedRevert: candidate.error, verified: true, execution: 'ETH_CALL_REAL_ENGINE' });
        }
        assert.deepEqual(await transport().identity(domain), before);
      }
      report.adversarial = adversarial;
      for (const market of LOCAL_MARKETS) source.setMode(market, 'missing-time');
      const missing = await processAll();
      for (const result of missing) assert.equal(result.reason, 'MISSING_OR_BAD_SOURCE_TIME');
      for (const market of LOCAL_MARKETS) source.setMode(market, 'outage');
      const outage = await processAll();
      for (const result of outage) assert.equal(result.reason, 'FIXTURE_HTTP_503');
      for (const market of LOCAL_MARKETS) source.setMode(market, 'stale');
      await advance(40);
      const stale = await processAll();
      for (const result of stale) assert.equal(result.reason, 'STALE_OR_FUTURE_SOURCE_TIME');
      report.staleCoverage = await twapCheck(false);
      for (const market of LOCAL_MARKETS) source.setMode(market, 'thin');
      await advance(1); const thin = await processAll(); assertDelivered(thin);
      for (const result of thin) assert.equal(result.depthValid, false);
      for (const market of LOCAL_MARKETS) source.setMode(market, 'valid');
      for (let checkpoint = 0; checkpoint <= 31; checkpoint += 1) {
        await advance(10); assertDelivered(await processAll());
      }
      report.fullWindow = await twapCheck(true);
      report.sourceFailures = { missingTimestamp: true, httpOutage: true, staleRejectedBeforeSigning: true,
        invalidDepthAcceptedAsUncovered: true, full300SecondCoverageRecovered: true };
    }
    const deliveries = LOCAL_MARKETS.flatMap(market => accepted(market).map(packet => ({ market,
      observation: packet.packet.observation, digest: packet.digest, delivery: relay!.get(domains[market], packet.packet.observation.sequence) })));
    const nonces = deliveries.map(item => item.delivery!.nonce.toString());
    assert.equal(new Set(nonces).size, nonces.length, 'DUPLICATE_TRANSACTION_NONCE');
    for (const market of activeMarkets) {
      const state = await client.readContract({ address: manifest.markets[market].engine, abi: SOURCE_ABI,
        functionName: 'sourceState', args: [fixture.sourceId as Hex] });
      assert.equal(state.lastSequence, accepted(market).at(-1)!.packet.observation.sequence);
    }
    assert.equal(journal!.verify(), true); assert.equal(packets!.verify(), true);
    report.deliveries = deliveries; report.sourceHttpRequests = source.requestCount(); report.journalsVerified = true;
    report.completed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    close(); await source.close(); save();
  }
  console.log(json({ completed: true, output, operation: mode, acceptedPackets: (report.deliveries as unknown[]).length }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
