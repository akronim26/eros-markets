import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, recoverAddress, type Hex } from 'viem';
import { PacketStore } from '../src/packet-store.js';
import { signPrepared } from '../src/publication.js';
import { PRICING_POLICY } from '../src/rules.js';
import { observationDigest } from '../src/wire.js';
import type { KuruMarketParams, KuruSnapshot, RawLevel } from '../src/native/kuru.js';
import { prepareNativeObservation, verifyNativeListing, type NativeDestination } from '../src/native/publication.js';
import { NATIVE_DEPTH_POLICY, NATIVE_FAILURE_POLICY, NATIVE_TIMESTAMP_POLICY, nativeRulesHash, parseNativeRules } from '../src/native/rules.js';
import { account, signer } from './publication-fixture.js';

const A = (n: string) => getAddress('0x' + n.padStart(40, '0'));
const H = (c: string) => ('0x' + c.repeat(64)) as Hex;
const [BOOK, YES, NO, USDC, VAULT, ENGINE] = ['b00c', 'e5e51', 'e5e52', 'c011', 'fa017', 'e0e0'].map(A) as [string, string, string, string, string, string];
const T0 = 1_800_000_000n;

const rules = parseNativeRules({ schemaVersion: '1', venue: 'kuru', chainId: '31337', marketId: H('a'), sourceId: H('b'),
  kuruOrderBook: BOOK, yesToken: YES, noToken: NO, collateral: USDC, outcomeVault: VAULT, outcomeLabel: 'YES',
  erosRulesHash: H('c'), scheduledT: (T0 + 172800n).toString(), depthNLots: '100000', maxSpreadWad: '250000000000000000',
  pricingPolicy: PRICING_POLICY, depthPolicy: NATIVE_DEPTH_POLICY, timestampPolicy: NATIVE_TIMESTAMP_POLICY, failurePolicy: NATIVE_FAILURE_POLICY });
const dest: NativeDestination = { chainId: '31337', engineAddress: ENGINE, marketId: H('a'), sourceId: H('b'),
  sourceRulesHash: nativeRulesHash(rules), signerAddress: account.address, scheduledT: rules.scheduledT };
const params: KuruMarketParams = { pricePrecision: 1000n, sizePrecision: 1000n, baseAsset: YES as Hex, baseDecimals: 6n,
  quoteAsset: USDC as Hex, quoteDecimals: 6n, tickSize: 1n, minSize: 1n, maxSize: 10n ** 9n, takerFeeBps: 0n, makerFeeBps: 0n };
const lvl = (price: bigint, size: bigint): RawLevel => ({ price, size });
const snap = (bids = [lvl(400n, 150_000n)], asks = [lvl(600n, 50_000n), lvl(610n, 100_000n)]): KuruSnapshot => ({
  chainId: 31337n, market: BOOK as Hex, blockNumber: 9n, blockHash: H('d'), blockTimestamp: T0, params,
  l2: { blockNumber: 9n, bids, asks }, vaultBidSize: 0n, vaultAskSize: 0n, raw: { marketParams: '0x', l2Book: '0x', vaultParams: '0x' } });
const PUBLISHED_MS = T0 * 1000n + 3000n;

test('valid native snapshot becomes a standard observation packet with hand-computed fields', () => {
  const p = prepareNativeObservation(31337n, dest, rules, snap(), 7n, PUBLISHED_MS, 5000n, null);
  // bid 100 @ 0.400; ask 50 @ 0.600 + 50 @ 0.610 -> 0.605; mid floor((0.400 + 0.605)/2) = 0.5025.
  assert.deepEqual(p.observation, { marketId: H('a'), sourceId: H('b'), sequence: 7n, observedAt: T0, publishedAt: T0 + 3n,
    priceWad: 502_500_000_000_000_000n, impactBidWad: 400_000_000_000_000_000n, impactAskWad: 605_000_000_000_000_000n,
    bidDepthLots: 150_000n, askDepthLots: 150_000n, sourceRulesHash: nativeRulesHash(rules) });
  assert.equal(p.sourceMs, T0 * 1000n);
  assert.equal(p.domain.chainId, 31337n);
  assert.match(p.evidenceHash, /^0x[0-9a-f]{64}$/);
});

test('fresh thin native book publishes a zero-price invalid-depth checkpoint with observed depth', () => {
  const p = prepareNativeObservation(31337n, dest, rules, snap([lvl(400n, 99_999n)]), 1n, PUBLISHED_MS, 5000n, null);
  assert.deepEqual([p.observation.priceWad, p.observation.impactBidWad, p.observation.impactAskWad], [0n, 0n, 0n]);
  assert.deepEqual([p.observation.bidDepthLots, p.observation.askDepthLots], [99_999n, 150_000n]);
});

test('stale, repeated, quarantined or mis-bound native snapshots are never prepared', () => {
  assert.throws(() => prepareNativeObservation(31337n, dest, rules, snap(), 1n, (T0 + 31n) * 1000n, 5000n, null), /STALE/);
  assert.throws(() => prepareNativeObservation(31337n, dest, rules, snap(), 2n, PUBLISHED_MS, 5000n, T0 * 1000n), /NOT_ADVANCED/);
  assert.throws(() => prepareNativeObservation(31337n, dest, rules, { ...snap(), chainId: 10143n }, 1n, PUBLISHED_MS, 5000n, null), /CHAIN_IDENTITY/);
  assert.throws(() => prepareNativeObservation(10143n, dest, rules, snap(), 1n, PUBLISHED_MS, 5000n, null), /DEVELOPMENT_CHAIN_ONLY/);
  assert.throws(() => prepareNativeObservation(31337n, { ...dest, sourceRulesHash: H('9') }, rules, snap(), 1n, PUBLISHED_MS, 5000n, null), /rulesHash/);
  assert.throws(() => prepareNativeObservation(31337n, { ...dest, scheduledT: '1' }, rules, snap(), 1n, PUBLISHED_MS, 5000n, null), /scheduledT/);
  assert.throws(() => prepareNativeObservation(31337n, dest, rules, snap(), 1n, PUBLISHED_MS, 0n, null), /HEADROOM/);
});

test('native packets flow through the existing packet store and signer unchanged', async () => {
  const store = new PacketStore(':memory:');
  const now = PUBLISHED_MS;
  try {
    const built = prepareNativeObservation(31337n, dest, rules, snap(), 1n, PUBLISHED_MS, 5000n, null);
    const fence = store.acquire(built.domain, 'owner', now, 100000n);
    store.reconcile(built.domain, 'owner', fence, now, { lastSequence: 0n, lastObservedAt: 0n });
    const allocated = store.allocate(built.domain, 'owner', fence, now,
      s => prepareNativeObservation(31337n, dest, rules, snap(), s, PUBLISHED_MS, 5000n, null));
    assert.equal(allocated.observation.sequence, 1n);
    const signed = await signPrepared(store, built.domain, 'owner', fence, 1n, signer, () => now, 5000n);
    assert.equal(signed.state, 'SIGNED');
    assert.equal(signed.digest, observationDigest(allocated.observation, 31337n, ENGINE));
    assert.equal(await recoverAddress({ hash: signed.digest, signature: signed.signature! }), account.address);
  } finally { store.close(); }
});

test('engine listing must pin the native source, signer, rules, depth rule, T, collateral and event rules', () => {
  const listing = { marketId: H('a'), indexSourceId: H('b'), indexSigner: account.address, indexRulesHash: nativeRulesHash(rules),
    depthNLots: 100000n, maxSpreadWad: 250000000000000000n, scheduledT: rules.scheduledT, token: USDC, rulesHash: H('c'), fundingEnabled: false };
  verifyNativeListing(dest, rules, listing);
  for (const [k, v] of Object.entries({ indexSigner: A('dead'), indexRulesHash: H('9'), depthNLots: 1n, token: A('dead'), rulesHash: H('9'), fundingEnabled: true }))
    assert.throws(() => verifyNativeListing(dest, rules, { ...listing, [k]: v }), new RegExp(`LISTING_PIN_MISMATCH_${k}`), k);
});
