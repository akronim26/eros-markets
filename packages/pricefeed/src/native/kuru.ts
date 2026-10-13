import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import type { Book, Level } from '../book.js';
import { WAD, json } from '../math.js';

/** Read-only subset of the Kuru OrderBook ABI (kuru-sdk abi/OrderBook.json). */
export const KURU_ORDERBOOK_ABI = [
  { type: 'function', name: 'getMarketParams', stateMutability: 'view', inputs: [], outputs: [
    { type: 'uint32', name: 'pricePrecision' }, { type: 'uint96', name: 'sizePrecision' },
    { type: 'address', name: 'baseAsset' }, { type: 'uint256', name: 'baseDecimals' },
    { type: 'address', name: 'quoteAsset' }, { type: 'uint256', name: 'quoteDecimals' },
    { type: 'uint32', name: 'tickSize' }, { type: 'uint96', name: 'minSize' }, { type: 'uint96', name: 'maxSize' },
    { type: 'uint256', name: 'takerFeeBps' }, { type: 'uint256', name: 'makerFeeBps' }] },
  { type: 'function', name: 'getL2Book', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes', name: '' }] },
  { type: 'function', name: 'getVaultParams', stateMutability: 'view', inputs: [], outputs: [
    { type: 'address', name: 'kuruAmmVault' }, { type: 'uint256', name: 'vaultBestBid' },
    { type: 'uint96', name: 'bidPartiallyFilledSize' }, { type: 'uint256', name: 'vaultBestAsk' },
    { type: 'uint96', name: 'askPartiallyFilledSize' }, { type: 'uint96', name: 'vaultBidOrderSize' },
    { type: 'uint96', name: 'vaultAskOrderSize' }, { type: 'uint96', name: 'spread' }] },
] as const;

export type KuruMarketParams = {
  pricePrecision: bigint; sizePrecision: bigint; baseAsset: Address; baseDecimals: bigint;
  quoteAsset: Address; quoteDecimals: bigint; tickSize: bigint; minSize: bigint; maxSize: bigint;
  takerFeeBps: bigint; makerFeeBps: bigint;
};
export type RawLevel = { price: bigint; size: bigint };
export type KuruL2 = { blockNumber: bigint; bids: RawLevel[]; asks: RawLevel[] };

const MAX_LEVELS = 10000;

/**
 * Decode `getL2Book()` bytes: one block-number word, then (price, size) word pairs for bids until
 * a zero price word, then (price, size) pairs for asks until a zero price word or the end.
 * Prices are in `pricePrecision` units and sizes in `sizePrecision` units. Resting manual orders
 * only: Kuru AMM vault liquidity is not included and is not counted by the native source.
 */
export function decodeL2Book(data: Hex): KuruL2 {
  if (!/^0x([0-9a-fA-F]{64})+$/.test(data)) throw new Error('BAD_L2_ENCODING');
  const words = data.slice(2).match(/.{64}/g)!.map(w => BigInt('0x' + w));
  const blockNumber = words[0]!;
  let i = 1;
  const side = (): RawLevel[] => {
    const out: RawLevel[] = [];
    while (i < words.length) {
      const price = words[i++]!;
      if (price === 0n) break;
      if (i >= words.length) throw new Error('TRUNCATED_L2_LEVEL');
      out.push({ price, size: words[i++]! });
      if (out.length > MAX_LEVELS) throw new Error('TOO_MANY_LEVELS');
    }
    return out;
  };
  const bids = side(), asks = side();
  if (words.slice(i).some(w => w !== 0n)) throw new Error('TRAILING_L2_DATA');
  return { blockNumber, bids, asks };
}

function powerOfTen(value: bigint): boolean {
  for (let p = 1n; p <= WAD; p *= 10n) if (p === value) return true;
  return false;
}

/**
 * Convert a decoded Kuru book into the publisher's normalized `Book` (WAD price, WAD-scaled claims),
 * so the existing `summarizeBook` impact arithmetic is reused unchanged. Exact integer conversion:
 * both precisions must be powers of ten no larger than 1e18. Prices at or above 1 (or zero) are
 * outside the probability domain and invalidate the source; they are never clamped.
 */
export function toBook(l2: KuruL2, p: KuruMarketParams): Book {
  if (!powerOfTen(p.pricePrecision) || !powerOfTen(p.sizePrecision)) throw new Error('UNSUPPORTED_PRECISION');
  if (p.tickSize === 0n || p.minSize === 0n) throw new Error('BAD_ORDER_CONSTRAINTS');
  const priceScale = WAD / p.pricePrecision, sizeScale = WAD / p.sizePrecision;
  const levels = (raw: RawLevel[], descending: boolean): Level[] => {
    const grouped = new Map<bigint, bigint>();
    for (const { price, size } of raw) {
      if (price >= p.pricePrecision) throw new Error('PRICE_OUT_OF_DOMAIN');
      if (price % p.tickSize !== 0n) throw new Error('OFF_TICK_GRID');
      if (size === 0n) continue;
      grouped.set(price, (grouped.get(price) ?? 0n) + size);
    }
    return [...grouped].map(([price, size]) => ({ priceWad: price * priceScale, quantityScaled: size * sizeScale }))
      .sort((a, b) => a.priceWad === b.priceWad ? 0 : (a.priceWad < b.priceWad ? -1 : 1) * (descending ? -1 : 1));
  };
  return { bids: levels(l2.bids, true), asks: levels(l2.asks, false),
    tickWad: p.tickSize * priceScale, minimumQuantityScaled: p.minSize * sizeScale };
}

/** Minimal read client (a viem PublicClient satisfies it). */
export type KuruReadClient = {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: 'finalized' | 'latest' } | { blockNumber: bigint }):
    Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
  call(args: { to: Address; data: Hex; blockNumber: bigint }): Promise<{ data?: Hex | undefined }>;
};

/** One canonical-block capture of everything the native source needs, with raw evidence retained. */
export type KuruSnapshot = {
  chainId: bigint; market: Address; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint;
  params: KuruMarketParams; l2: KuruL2; vaultBidSize: bigint; vaultAskSize: bigint;
  raw: { marketParams: Hex; l2Book: Hex; vaultParams: Hex };
};

async function callAt(client: KuruReadClient, market: Address, fn: 'getMarketParams' | 'getL2Book' | 'getVaultParams',
  blockNumber: bigint): Promise<Hex> {
  const result = await client.call({ to: market, data: encodeFunctionData({ abi: KURU_ORDERBOOK_ABI, functionName: fn }), blockNumber });
  if (!result.data || result.data === '0x') throw new Error(`EMPTY_CALL_RESULT:${fn}`);
  return result.data;
}

/**
 * Read market parameters, the L2 book and AMM vault sizes at one pinned block (default: the
 * chain's `finalized` block), then re-read that block's header and require the same hash. Any
 * inconsistency throws: an inconsistent snapshot is never signed.
 */
export async function readKuruSnapshot(client: KuruReadClient, market: Address,
  blockTag: 'finalized' | 'latest' = 'finalized'): Promise<KuruSnapshot> {
  const chainId = BigInt(await client.getChainId());
  const head = await client.getBlock({ blockTag });
  if (head.number === null || head.hash === null) throw new Error('PENDING_BLOCK');
  const blockNumber = head.number;
  const [marketParams, l2Book, vaultParams] = await Promise.all([
    callAt(client, market, 'getMarketParams', blockNumber), callAt(client, market, 'getL2Book', blockNumber),
    callAt(client, market, 'getVaultParams', blockNumber)]);
  const again = await client.getBlock({ blockNumber });
  if (again.hash !== head.hash || again.timestamp !== head.timestamp) throw new Error('BLOCK_REPLACED');
  const m = decodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getMarketParams', data: marketParams });
  const params: KuruMarketParams = { pricePrecision: BigInt(m[0]), sizePrecision: m[1], baseAsset: m[2], baseDecimals: m[3],
    quoteAsset: m[4], quoteDecimals: m[5], tickSize: BigInt(m[6]), minSize: m[7], maxSize: m[8], takerFeeBps: m[9], makerFeeBps: m[10] };
  const l2 = decodeL2Book(decodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getL2Book', data: l2Book }));
  if (l2.blockNumber !== blockNumber) throw new Error('L2_BLOCK_MISMATCH');
  const v = decodeFunctionResult({ abi: KURU_ORDERBOOK_ABI, functionName: 'getVaultParams', data: vaultParams });
  return { chainId, market, blockNumber, blockHash: head.hash, blockTimestamp: head.timestamp, params, l2,
    vaultBidSize: v[5], vaultAskSize: v[6], raw: { marketParams, l2Book, vaultParams } };
}

/** SHA-256 of the canonical JSON evidence (journal provenance; not part of the on-chain observation). */
export function snapshotEvidenceHash(s: KuruSnapshot): Hex {
  return `0x${createHash('sha256').update(json({ chainId: s.chainId, market: s.market.toLowerCase(),
    blockNumber: s.blockNumber, blockHash: s.blockHash, blockTimestamp: s.blockTimestamp, raw: s.raw })).digest('hex')}`;
}
