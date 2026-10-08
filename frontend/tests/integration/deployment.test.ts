import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { keccak256, type Hex } from 'viem';
import { publicManifest as manifest, deploymentManifests } from '../../src/config/deployment';
import { client } from '../../src/lib/public-client';
import { ensureDeployment, ensureNetwork, deploymentCacheKey, canonicalRead } from '../../src/lib/deployment-check';

type Manifest = (typeof deploymentManifests)[number];
type ContractRead = { address: string; functionName: string; args?: readonly unknown[] };
const zeroAddress = '0x0000000000000000000000000000000000000000';
const anchorNumber = 99_999_999n;
const anchorHash = keccak256('0x1234');
const changedHash = keccak256('0xab');
let nextClock = 1_000_000;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const uniquePins = (m: Manifest) => [...new Map([
  ...Object.values(m.contracts), ...m.markets.map(market => ({ address: market.engine, codehash: market.codehash })),
].map(pin => [pin.address.toLowerCase(), pin])).values()];

function fixture(t: TestContext) {
  const state = {
    clock: nextClock += 1_000_000, chain: Number(manifest.chainId),
    badCode: new Set<string>(), badEvidence: new Set<string>(),
    badBinding: false, badListing: false, reorg: false, rpcFailure: false,
    active: 0, peak: 0, chainCalls: 0,
    blocks: [] as { blockNumber?: bigint; blockTag?: string }[],
    codes: [] as string[], multicalls: [] as ContractRead[][],
    pauseCodes: undefined as Promise<void> | undefined,
  };
  const pins = new Map(deploymentManifests.flatMap(uniquePins).map(pin => [pin.address.toLowerCase(), pin.codehash]));
  async function rpc<T>(body: () => T | Promise<T>): Promise<T> {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    try { await nextTurn(); return await body(); }
    finally { state.active--; }
  }
  function contract({ address, functionName, args }: ContractRead) {
    const selected = deploymentManifests.find(m => m.markets.some(market => market.engine.toLowerCase() === address.toLowerCase() || market.marketId === args?.[0]))
      ?? deploymentManifests.find(m => Object.values(m.contracts).some(c => c.address.toLowerCase() === address.toLowerCase()));
    assert.ok(selected, 'only reviewed contracts are queried');
    const c = selected.contracts;
    const market = selected.markets.find(m => m.engine.toLowerCase() === address.toLowerCase() || m.marketId === args?.[0]);
    if (functionName === 'engineOf') return state.badListing ? zeroAddress : market!.engine;
    if (functionName === 'listing') return {
      marketId: market!.marketId, indexSourceId: market!.sourceId, token: c.CollateralToken.address,
      registry: c.MarketRegistry.address, resolutionAuthority: c.ResolutionOracle.address,
    };
    if (functionName === 'listingHash') return market!.listingHash;
    return state.badBinding ? zeroAddress : ({ factory: c.MarketFactory.address, oracle: c.ResolutionOracle.address,
      registry: c.MarketRegistry.address, collateralVault: c.CollateralVault.address, token: c.CollateralToken.address } as Record<string, string>)[functionName];
  }
  t.mock.method(Date, 'now', () => state.clock);
  t.mock.method(client, 'getChainId', () => rpc(() => { state.chainCalls++; return state.chain; }));
  t.mock.method(client, 'getBlock', (args: { blockNumber?: bigint; blockTag?: string }) => rpc(() => {
    state.blocks.push(args);
    if (args.blockTag === 'finalized') return { number: anchorNumber, hash: anchorHash };
    if (args.blockNumber === anchorNumber) return { number: anchorNumber, hash: state.reorg ? changedHash : anchorHash };
    const evidence = deploymentManifests.find(m => BigInt(m.verifiedAt.blockNumber) === args.blockNumber);
    assert.ok(evidence);
    return { number: args.blockNumber, hash: state.badEvidence.has(evidence.verifiedAt.blockHash) ? changedHash : evidence.verifiedAt.blockHash };
  }));
  t.mock.method(client, 'call', ({ data, blockNumber }: { data: Hex; blockNumber: bigint }) => rpc(async () => {
    assert.match(data, /^0x73[\da-fA-F]{40}3f60005260206000f3$/);
    assert.equal(blockNumber, anchorNumber);
    const address = `0x${data.slice(4, 44)}`.toLowerCase();
    state.codes.push(address);
    await state.pauseCodes;
    if (state.rpcFailure) throw new Error('RPC unavailable');
    assert.ok(pins.has(address));
    return { data: state.badCode.has(address) ? changedHash : pins.get(address) };
  }));
  t.mock.method(client, 'multicall', ({ contracts, blockNumber, allowFailure, deployless }: {
    contracts: ContractRead[]; blockNumber: bigint; allowFailure: boolean; deployless: boolean;
  }) => rpc(() => {
    assert.equal(blockNumber, anchorNumber);
    assert.equal(allowFailure, false);
    assert.equal(deployless, true);
    state.multicalls.push(contracts);
    return contracts.map(contract);
  }));
  t.mock.method(client, 'readContract', async () => { throw new Error('Bindings and listings must use the combined multicall'); });
  return state;
}

test('chain-only head verification and unknown targets never read deployment contracts', async t => {
  const state = fixture(t);
  await Promise.all([ensureNetwork(), ensureNetwork()]);
  assert.equal(state.chainCalls, 1, 'concurrent chain checks are shared');
  assert.deepEqual(state.blocks, []);
  assert.deepEqual(state.codes, []);
  await assert.rejects(ensureDeployment(zeroAddress), /reviewed deployment/);
  assert.throws(() => deploymentCacheKey('not-an-address'), /reviewed deployment/);
  assert.equal(state.chainCalls, 1, 'unknown targets fail locally');
  state.chain = 1;
  await assert.rejects(ensureNetwork(), /network/);
});

test('current deployment ignores broken archives and verifies the archive only when accessed', async t => {
  const state = fixture(t);
  const archive = deploymentManifests[1];
  const archivedEngine = archive.markets[0].engine.toLowerCase();
  state.badCode.add(archivedEngine);
  await ensureDeployment();
  assert.deepEqual(new Set(state.codes), new Set(uniquePins(manifest).map(p => p.address.toLowerCase())));
  assert.equal(state.multicalls.length, 1);
  assert.equal(state.multicalls[0].length, 6 + manifest.markets.length * 4);
  assert.equal(state.multicalls[0].filter(c => c.functionName === 'factory').length, 1);
  const currentCodes = state.codes.length;
  await assert.rejects(ensureDeployment(archive.markets[0].engine), /code/);
  assert.ok(state.codes.includes(archivedEngine));
  state.badCode.clear();
  await ensureDeployment(archive.markets[0].engine);
  assert.equal(state.multicalls.at(-1)!.filter(c => c.functionName === 'factory').length, 0,
    'archived registries may point at a newer factory');
  const afterArchive = state.codes.length;
  await ensureDeployment(archive.contracts.CollateralVault.address);
  assert.equal(state.codes.length, afterArchive, 'an archived vault resolves to the cached archive proof');
  await ensureDeployment(manifest.markets[0].engine);
  assert.equal(state.codes.length, afterArchive, 'archive failure does not invalidate the successful current proof');
  assert.ok(afterArchive > currentCodes);
});

test('contract targets use their deployment and cache identities include reviewed pins and client identity', async t => {
  const state = fixture(t);
  const engine = manifest.markets[0].engine;
  const vault = manifest.contracts.CollateralVault.address;
  const key = deploymentCacheKey(engine);
  assert.equal(deploymentCacheKey(engine.toLowerCase()), key);
  assert.equal(deploymentCacheKey(vault), key);
  assert.notEqual(deploymentCacheKey(deploymentManifests[1].markets[0].engine), key);
  await ensureDeployment(vault);
  await ensureDeployment(engine);
  assert.equal(state.multicalls.length, 1);
  const pin = manifest.markets[0];
  const oldHash = pin.codehash;
  try {
    pin.codehash = changedHash;
    assert.notEqual(deploymentCacheKey(engine), key);
    await assert.rejects(ensureDeployment(engine), /code/, 'changed reviewed pins cannot inherit cached verification');
  }
  finally { pin.codehash = oldHash; }
  const uid = client.uid;
  try {
    (client as { uid: string }).uid = 'different-client';
    assert.notEqual(deploymentCacheKey(engine), key);
    const codeCount = state.codes.length;
    await ensureDeployment(engine);
    assert.ok(state.codes.length > codeCount, 'a different client identity requires a new verification');
  }
  finally { (client as { uid: string }).uid = uid; }
});

test('concurrent verification is shared per manifest, expires after five minutes and bounds RPC work', async t => {
  const state = fixture(t);
  const engine = manifest.markets[0].engine;
  await Promise.all(Array.from({ length: 12 }, () => ensureDeployment(engine)));
  assert.equal(state.multicalls.length, 1);
  assert.equal(state.codes.length, uniquePins(manifest).length);
  state.clock += 299999;
  await ensureDeployment(engine);
  assert.equal(state.multicalls.length, 1);
  state.clock += 1;
  await ensureDeployment(engine);
  assert.equal(state.multicalls.length, 2);
  await Promise.all(deploymentManifests.slice(1).map(m => ensureDeployment(m.markets[0].engine)));
  assert.equal(state.multicalls.length, deploymentManifests.length + 1);
  assert.ok(state.peak > 1, 'independent checks execute in parallel');
  assert.ok(state.peak <= 4, `verifier concurrency must stay bounded, observed ${state.peak}`);
});

test('wrong networks, changed code, bindings, listings and evidence fail closed and can retry', async t => {
  const state = fixture(t);
  state.chain = 1;
  await assert.rejects(ensureDeployment(), /network/);
  state.chain = manifest.chainId;
  state.badCode.add(manifest.markets[0].engine.toLowerCase());
  await assert.rejects(ensureDeployment(), /code/);
  state.badCode.clear(); state.badBinding = true;
  await assert.rejects(ensureDeployment(), /bindings/);
  state.badBinding = false; state.badListing = true;
  await assert.rejects(ensureDeployment(), /identity/);
  state.badListing = false; state.badEvidence.add(manifest.verifiedAt.blockHash);
  await assert.rejects(ensureDeployment(), /canonical/);
  state.badEvidence.clear(); state.rpcFailure = true;
  await assert.rejects(ensureDeployment(), /RPC unavailable/);
  state.rpcFailure = false;
  await ensureDeployment();
});

test('a network failure clears cached proofs and cannot let an invalidated in-flight check succeed', async t => {
  const state = fixture(t);
  await ensureDeployment();
  const initialCount = state.codes.length;
  state.chain = 1;
  await assert.rejects(ensureDeployment(), /network/);
  state.chain = manifest.chainId;
  await ensureDeployment();
  assert.equal(state.codes.length, initialCount * 2);
  let release!: () => void;
  state.pauseCodes = new Promise<void>(resolve => { release = resolve; });
  const archive = ensureDeployment(deploymentManifests[1].markets[0].engine);
  const rejected = assert.rejects(archive, /invalidated/);
  while (state.codes.length === initialCount * 2) await nextTurn();
  state.chain = 1;
  const network = assert.rejects(ensureNetwork(), /network/);
  release();
  await network;
  await rejected;
  state.pauseCodes = undefined;
  state.chain = manifest.chainId;
  await ensureDeployment(deploymentManifests[1].markets[0].engine);
});

test('reorgs during verification or a pinned read discard proof caches and reject mixed snapshots', async t => {
  const state = fixture(t);
  state.reorg = true;
  await assert.rejects(ensureDeployment(), /Deployment read block changed/);
  state.reorg = false;
  await ensureDeployment();
  const count = state.multicalls.length;
  await assert.rejects(canonicalRead(anchorNumber, async () => {
    state.reorg = true;
    return { balance: 1n };
  }), /Read block changed/);
  state.reorg = false;
  await ensureDeployment();
  assert.equal(state.multicalls.length, count + 1, 'reorg invalidates a previously cached deployment proof');
});

test('an account read rejects a different fork than the completed market snapshot before reading balances', async t => {
  const state = fixture(t);
  await ensureDeployment();
  const count = state.multicalls.length;
  const market = await canonicalRead(anchorNumber, async anchor => ({ blockHash: anchor.hash }));
  assert.equal(market.blockHash, anchorHash);
  state.reorg = true;
  let accountRead = false;
  await assert.rejects(canonicalRead(anchorNumber, async () => {
    accountRead = true;
    return { balance: 1n };
  }, market.blockHash), /Read block changed/);
  assert.equal(accountRead, false, 'the account callback must not run against a different market block hash');
  state.reorg = false;
  await ensureDeployment();
  assert.equal(state.multicalls.length, count + 1, 'a mismatched paired snapshot invalidates deployment verification');
});
