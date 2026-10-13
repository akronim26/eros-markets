import { WAD, UINT256_MAX, ceilDiv, floorLots, parseDecimal, priceWad } from './math.js';

export type ImpactMethod = 'vwap' | 'marginal';
export type Level = { priceWad: bigint; quantityScaled: bigint };
export type Book = { bids: Level[]; asks: Level[]; tickWad: bigint; minimumQuantityScaled: bigint };
export type Summary = {
  valid: boolean; reason: string | null; impactBidWad: bigint | null;
  impactAskWad: bigint | null; priceWad: bigint | null; bidDepthLots: bigint; askDepthLots: bigint;
};

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_OBJECT');
  return value as Record<string, unknown>;
}

function levels(raw: unknown, tick: bigint, descending: boolean): Level[] {
  if (!Array.isArray(raw) || raw.length > 10000) throw new Error('BAD_BOOK_LEVELS');
  const grouped = new Map<bigint, bigint>();
  for (const entry of raw) {
    const level = record(entry);
    const p = priceWad(level.price), q = parseDecimal(level.size);
    if (p % tick !== 0n) throw new Error('OFF_TICK_GRID');
    if (q === 0n) continue;
    const total = (grouped.get(p) ?? 0n) + q;
    if (total > UINT256_MAX) throw new Error('QUANTITY_OVERFLOW');
    grouped.set(p, total);
  }
  if (grouped.size === 0) throw new Error('EMPTY_BOOK_SIDE');
  return [...grouped].map(([priceWad, quantityScaled]) => ({ priceWad, quantityScaled }))
    .sort((a, b) => a.priceWad === b.priceWad ? 0 : (a.priceWad < b.priceWad ? -1 : 1) * (descending ? -1 : 1));
}

export function normalizeBook(value: unknown): Book {
  const raw = record(value);
  const tick = priceWad(raw.tick_size), minimum = parseDecimal(raw.min_order_size);
  if (tick === 0n || minimum === 0n) throw new Error('BAD_ORDER_CONSTRAINTS');
  return { bids: levels(raw.bids, tick, true), asks: levels(raw.asks, tick, false),
    tickWad: tick, minimumQuantityScaled: minimum };
}

function walk(rows: Level[], quantity: bigint, method: ImpactMethod, ask: boolean): bigint | null {
  let remaining = quantity, weighted = 0n;
  for (const level of rows) {
    const take = remaining < level.quantityScaled ? remaining : level.quantityScaled;
    weighted += level.priceWad * take;
    remaining -= take;
    if (remaining === 0n) return method === 'marginal' ? level.priceWad
      : ask ? ceilDiv(weighted, quantity) : weighted / quantity;
  }
  return null;
}

export function summarizeBook(book: Book, depthNLots: bigint, maxSpreadWad: bigint, method: ImpactMethod): Summary {
  if (depthNLots <= 0n || depthNLots > UINT256_MAX || maxSpreadWad < 0n || maxSpreadWad > WAD)
    throw new Error('BAD_DEPTH_RULE');
  if (method !== 'vwap' && method !== 'marginal') throw new Error('UNKNOWN_IMPACT_METHOD');
  const total = (rows: Level[]) => rows.reduce((sum, row) => sum + row.quantityScaled, 0n);
  const bidDepthLots = floorLots(total(book.bids)), askDepthLots = floorLots(total(book.asks));
  if (bidDepthLots > UINT256_MAX || askDepthLots > UINT256_MAX) throw new Error('DEPTH_OVERFLOW');
  const quantity = depthNLots * WAD / 1000n;
  const bid = walk(book.bids, quantity, method, false), ask = walk(book.asks, quantity, method, true);
  const reason = quantity < book.minimumQuantityScaled ? 'BELOW_SOURCE_MINIMUM'
    : bid === null || ask === null ? 'INSUFFICIENT_DEPTH'
    : bid === 0n || ask >= WAD ? 'ENDPOINT_PRICE'
    : bid > ask || book.bids[0]!.priceWad > book.asks[0]!.priceWad ? 'CROSSED_BOOK'
    : ask - bid > maxSpreadWad ? 'EXCESSIVE_SPREAD' : null;
  return { valid: reason === null, reason, impactBidWad: bid, impactAskWad: ask,
    priceWad: reason === null ? (bid! + ask!) / 2n : null, bidDepthLots, askDepthLots };
}
