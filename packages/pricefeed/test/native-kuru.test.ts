import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionResult, getAddress, toFunctionSelector, type Hex } from 'viem';
import { RULES_DOMAIN } from '../src/rules.js';
import { inspectNativeSnapshot } from '../src/native/collector.js';
import { decodeL2Book, KURU_ORDERBOOK_ABI, readKuruSnapshot, toBook, type KuruMarketParams, type KuruReadClient,
  type KuruSnapshot, type RawLevel } from '../src/native/kuru.js';
import { NATIVE_RULES_DOMAIN, nativeRulesHash, parseNativeRules, type NativeRulesManifest } from '../src/native/rules.js';
import { NATIVE_DEPTH_POLICY, NATIVE_FAILURE_POLICY, NATIVE_TIMESTAMP_POLICY } from '../src/native/rules.js';
import { PRICING_POLICY } from '../src/rules.js';

const BOOK = getAddress('0x4ce01842efd0c26ae5f9c86db3258aa4524dd458');
const YES = getAddress('0x00000000000000000000000000000000000e5e51');
const NO = getAddress('0x00000000000000000000000000000000000e5e52');
const USDC = getAddress('0x82c7236a14b635afb6dc825115570afe4c23c1db');
const VAULT = getAddress('0x00000000000000000000000000000000000fa017');
const H = (s: string) => ('0x' + s.repeat(64).slice(0, 64)) as Hex;
const T0 = 1_800_000_000n;

const rules: NativeRulesManifest = parseNativeRules({
  schemaVersion: '1', venue: 'kuru', chainId: '10143', marketId: H('a'), sourceId: H('b'), kuruOrderBook: BOOK,
  yesToken: YES, noToken: NO, collateral: USDC, outcomeVault: VAULT, outcomeLabel: 'YES', erosRulesHash: H('c'),
  scheduledT: (T0 + 172800n).toString(), depthNLots: '100000', maxSpreadWad: '250000000000000000',
  pricingPolicy: PRICING_POLICY, depthPolicy: NATIVE_DEPTH_POLICY, timestampPolicy: NATIVE_TIMESTAMP_POLICY,
  failurePolicy: NATIVE_FAILURE_POLICY,
});
// Spike-verified parameters: 1 size unit = 0.001 claim (1 Eros lot); 1 price unit = 0.001 (1 Eros tick).
const params: KuruMarketParams = { pricePrecision: 1000n, sizePrecision: 1000n, baseAsset: YES, baseDecimals: 6n,
  quoteAsset: USDC, quoteDecimals: 6n, tickSize: 1n, minSize: 1n, maxSize: 1_000_000_000n, takerFeeBps: 30n, makerFeeBps: 10n };

function l2Hex(block: bigint, bids: RawLevel[], asks: RawLevel[], askTerminator = true): Hex {
  const w = (x: bigint) => x.toString(16).padStart(64, '0');
  return ('0x' + w(block) + bids.map(l => w(l.price) + w(l.size)).join('') + w(0n)
    + asks.map(l => w(l.price) + w(l.size)).join('') + (askTerminator ? w(0n) : '')) as Hex;
}
const lvl = (price: bigint, size: bigint): RawLevel => ({ price, size });
const BIDS = [lvl(400n, 150_000n), lvl(390n, 100_000n)];
const ASKS = [lvl(600n, 50_000n), lvl(610n, 100_000n)];

function snap(over: Partial<KuruSnapshot> = {}, bids = BIDS, asks = ASKS): KuruSnapshot {
  return { chainId: 10143n, market: BOOK, blockNumber: 70n, blockHash: H('d'), blockTimestamp: T0, params,
    l2: { blockNumber: 70n, bids, asks }, vaultBidSize: 0n, vaultAskSize: 0n,
    raw: { marketParams: '0x', l2Book: '0x', vaultParams: '0x' }, ...over };
}
const RECEIVED = T0 * 1000n + 2000n; // read 2 s after the pinned block

test('decodes Kuru getL2Book words: block, bids to zero, asks to zero or end', () => {
  const a = decodeL2Book(l2Hex(70n, BIDS, ASKS));
  assert.equal(a.blockNumber, 70n);
  assert.deepEqual(a.bids, BIDS);
  assert.deepEqual(a.asks, ASKS);
  assert.deepEqual(decodeL2Book(l2Hex(70n, BIDS, ASKS, false)).asks, ASKS);
  const empty = decodeL2Book(l2Hex(71n, [], []));
  assert.deepEqual([empty.bids, empty.asks], [[], []]);
  assert.throws(() => decodeL2Book('0x1234'), /BAD_L2_ENCODING/);
  const w = (x: bigint) => x.toString(16).padStart(64, '0');
  assert.throws(() => decodeL2Book(`0x${w(70n)}${w(400n)}`), /TRUNCATED_L2_LEVEL/); // price word without size
  assert.throws(() => decodeL2Book((l2Hex(70n, [], []) + w(5n)) as Hex), /TRAILING_L2_DATA/);
});

test('converts Kuru units to WAD prices and WAD-scaled claims exactly', () => {
  const b = toBook({ blockNumber: 1n, bids: [lvl(400n, 150_000n), lvl(400n, 1n)], asks: ASKS }, params);
  assert.deepEqual(b.bids[0], { priceWad: 400_000_000_000_000_000n, quantityScaled: 150_001n * 10n ** 15n });
  assert.equal(b.asks[0]!.priceWad, 600_000_000_000_000_000n);
  assert.equal(b.tickWad, 10n ** 15n);
  assert.equal(b.minimumQuantityScaled, 10n ** 15n);
  assert.throws(() => toBook({ blockNumber: 1n, bids: [], asks: [lvl(1000n, 1n)] }, params), /PRICE_OUT_OF_DOMAIN/);
  assert.throws(() => toBook({ blockNumber: 1n, bids: [lvl(401n, 1n)], asks: [] }, { ...params, tickSize: 10n }), /OFF_TICK_GRID/);
  assert.throws(() => toBook({ blockNumber: 1n, bids: [], asks: [] }, { ...params, pricePrecision: 999n }), /UNSUPPORTED_PRECISION/);
});

test('valid YES book yields N-sized impact VWAPs and block-timestamp source time', () => {
  const r = inspectNativeSnapshot(rules, snap(), RECEIVED, null, 5000n);
  assert.equal(r.status, 'COLLECTING', String(r.reason));
  // Hand arithmetic, N = 100 claims: bid fills 100 @ 0.400 -> 0.400;
  // ask fills 50 @ 0.600 + 50 @ 0.610 = 60.5 / 100 = 0.605; mid = (0.400 + 0.605) / 2 = 0.5025.
  assert.equal(r.summary!.impactBidWad, 400_000_000_000_000_000n);
  assert.equal(r.summary!.impactAskWad, 605_000_000_000_000_000n);
  assert.equal(r.summary!.priceWad, 502_500_000_000_000_000n);
  assert.equal(r.summary!.bidDepthLots, 250_000n); // 150 + 100 claims
  assert.equal(r.summary!.askDepthLots, 150_000n); // 50 + 100 claims
  assert.equal(r.time!.observedAt, T0);
  assert.match(String(r.evidenceHash), /^0x[0-9a-f]{64}$/);
});

test('fresh but thin, empty, crossed or wide books are authentic invalid-depth evidence', () => {
  const thin = inspectNativeSnapshot(rules, snap({}, BIDS, [lvl(600n, 99_999n)]), RECEIVED, null, 5000n);
  assert.deepEqual([thin.status, thin.reason], ['INVALID_DEPTH', 'INSUFFICIENT_DEPTH']);
  const empty = inspectNativeSnapshot(rules, snap({}, [], []), RECEIVED, null, 5000n);
  assert.deepEqual([empty.status, empty.reason], ['INVALID_DEPTH', 'INSUFFICIENT_DEPTH']);
  const crossed = inspectNativeSnapshot(rules, snap({}, [lvl(610n, 100_000n)], [lvl(600n, 100_000n)]), RECEIVED, null, 5000n);
  assert.deepEqual([crossed.status, crossed.reason], ['INVALID_DEPTH', 'CROSSED_BOOK']);
  // Spread 0.605 - 0.400 = 0.205 > 0.05.
  const tight = parseNativeRules({ ...rules, maxSpreadWad: '50000000000000000' });
  const wide = inspectNativeSnapshot(tight, snap(), RECEIVED, null, 5000n);
  assert.deepEqual([wide.status, wide.reason], ['INVALID_DEPTH', 'EXCESSIVE_SPREAD']);
  // Domain check only (spread limit opened to 1): a 0.999 ask is inside (0,1); a zero-size level is ignored.
  const open = parseNativeRules({ ...rules, maxSpreadWad: '1000000000000000000' });
  const endpoint = inspectNativeSnapshot(open, snap({}, [lvl(1n, 0n), lvl(400n, 100_000n)], [lvl(999n, 100_000n)]), RECEIVED, null, 5000n);
  assert.equal(endpoint.status, 'COLLECTING', String(endpoint.reason));
  assert.equal(endpoint.summary!.impactAskWad, 999_000_000_000_000_000n);
  // ... but an ask at 1.000 is outside the probability domain and is never clamped:
  const out = inspectNativeSnapshot(rules, snap({}, BIDS, [lvl(1000n, 100_000n)]), RECEIVED, null, 5000n);
  assert.deepEqual([out.status, out.reason], ['DEGRADED', 'PRICE_OUT_OF_DOMAIN']);
});

test('stale, repeated-second and post-T snapshots are withheld; backwards time is quarantined', () => {
  const stale = inspectNativeSnapshot(rules, snap(), (T0 + 31n) * 1000n, null, 5000n);
  assert.deepEqual([stale.status, stale.reason], ['DEGRADED', 'STALE_OR_FUTURE_SOURCE_TIME']);
  const same = inspectNativeSnapshot(rules, snap(), RECEIVED, T0 * 1000n, 5000n);
  assert.deepEqual([same.status, same.reason], ['DEGRADED', 'SOURCE_SECOND_NOT_ADVANCED']);
  const back = inspectNativeSnapshot(rules, snap(), RECEIVED, (T0 + 1n) * 1000n, 5000n);
  assert.deepEqual([back.status, back.reason], ['QUARANTINED', 'BACKWARDS_SOURCE_TIME']);
  const future = inspectNativeSnapshot(rules, snap(), (T0 - 1n) * 1000n, null, 5000n);
  assert.equal(future.status, 'DEGRADED');
  const lateT = parseNativeRules({ ...rules, scheduledT: T0.toString() });
  assert.equal(inspectNativeSnapshot(lateT, snap(), RECEIVED, null, 5000n).reason, 'AT_OR_AFTER_SCHEDULED_T');
});

test('wrong chain, book, pair orientation or decimals are quarantined', () => {
  const q = (s: KuruSnapshot) => inspectNativeSnapshot(rules, s, RECEIVED, null, 5000n);
  assert.deepEqual([q(snap({ chainId: 31337n })).status, q(snap({ chainId: 31337n })).reason], ['QUARANTINED', 'CHAIN_IDENTITY_MISMATCH']);
  assert.equal(q(snap({ market: NO })).reason, 'BOOK_IDENTITY_MISMATCH');
  assert.equal(q(snap({ params: { ...params, baseAsset: NO } })).reason, 'PAIR_IDENTITY_MISMATCH'); // NO book is not the source
  assert.equal(q(snap({ params: { ...params, baseAsset: USDC, quoteAsset: YES } })).reason, 'PAIR_IDENTITY_MISMATCH');
  assert.equal(q(snap({ params: { ...params, quoteDecimals: 18n } })).status, 'QUARANTINED');
});

test('native rules use their own domain and commit to every venue binding', () => {
  assert.notEqual(NATIVE_RULES_DOMAIN, RULES_DOMAIN);
  const h = nativeRulesHash(rules);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(nativeRulesHash(parseNativeRules({ ...rules })), h);
  for (const [k, v] of Object.entries({ kuruOrderBook: '0x00000000000000000000000000000000000fa018', yesToken: '0x00000000000000000000000000000000000E5E53',
    depthNLots: '100001', scheduledT: '1', chainId: '31337' }))
    assert.notEqual(nativeRulesHash(parseNativeRules({ ...rules, [k]: v })), h, k);
  assert.throws(() => parseNativeRules({ ...rules, venue: 'polymarket' }), /UNSUPPORTED_RULES_POLICY/);
  assert.throws(() => parseNativeRules({ ...rules, outcomeLabel: 'NO' }), /UNSUPPORTED_RULES_POLICY/);
  assert.throws(() => parseNativeRules({ ...rules, noToken: YES }), /DUPLICATE_RULES_ADDRESS/);
  assert.throws(() => parseNativeRules({ ...rules, extra: '1' }), /BAD_RULES_FIELDS/);
  assert.throws(() => parseNativeRules({ ...rules, depthNLots: '0' }), /BAD_RULES_DEPTH/);
});

const SELECTORS = Object.fromEntries(KURU_ORDERBOOK_ABI.map(f => [toFunctionSelector(f), f.name]));

/** Scripted read client: every call must be pinned to block 70; returns fixed encoded results. */
function fakeClient(opts: { secondHash?: Hex; l2Block?: bigint } = {}): KuruReadClient {
  const results: Record<string, Hex> = {
    getMarketParams: encodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getMarketParams', result: [
      1000, 1000n, YES, 6n, USDC, 6n, 1, 1n, 1_000_000_000n, 30n, 10n] }),
    getL2Book: encodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getL2Book', result: l2Hex(opts.l2Block ?? 70n, BIDS, ASKS) }),
    getVaultParams: encodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getVaultParams', result: [
      VAULT, 0n, 0n, 0n, 0n, 0n, 0n, 100n] }),
  };
  let blocks = 0;
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ number: 70n, hash: blocks++ === 0 ? H('d') : (opts.secondHash ?? H('d')), timestamp: T0 }),
    call: async ({ data, blockNumber }) => {
      assert.equal(blockNumber, 70n);
      const fn = SELECTORS[data.slice(0, 10)];
      assert.ok(fn, 'unexpected selector');
      return { data: results[fn] };
    },
  };
}

test('snapshot reads pin one block and reject replaced blocks or a mismatched L2 block', async () => {
  const s = await readKuruSnapshot(fakeClient(), BOOK);
  assert.deepEqual([s.chainId, s.blockNumber, s.blockTimestamp], [10143n, 70n, T0]);
  assert.deepEqual(s.l2.bids, BIDS);
  assert.deepEqual(s.l2.asks, ASKS);
  assert.deepEqual([s.params.pricePrecision, s.params.sizePrecision, s.params.baseAsset], [1000n, 1000n, YES]);
  assert.equal(inspectNativeSnapshot(rules, s, RECEIVED, null, 5000n).status, 'COLLECTING');
  await assert.rejects(readKuruSnapshot(fakeClient({ secondHash: H('e') }), BOOK), /BLOCK_REPLACED/);
  await assert.rejects(readKuruSnapshot(fakeClient({ l2Block: 69n }), BOOK), /L2_BLOCK_MISMATCH/);
});
