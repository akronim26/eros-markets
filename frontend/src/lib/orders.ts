export type OrderRecord = {
  owner: number; size: bigint; tick: number; flags: number; gen: number;
  marketEpoch: bigint; accountEpoch: bigint; reduceVersion: bigint; expiryBlock: number;
};

/** Discovery is not authority: every id must be checked against a pinned contract read. */
export function orderStatus(id: number, order: OrderRecord, context: {
  traderId: number; block: bigint; marketEpoch: bigint; accountEpoch: bigint; positionVersion: bigint;
}): "live" | "stale" | "closed" | "foreign" {
  if (order.size === 0n || !(order.flags & 4) || order.gen !== Math.floor(id / 2 ** 24)) return "closed";
  if (order.owner !== context.traderId) return "foreign";
  if (order.marketEpoch !== context.marketEpoch || order.accountEpoch !== context.accountEpoch
    || (order.expiryBlock !== 0 && context.block > BigInt(order.expiryBlock))
    || ((order.flags & 2) !== 0 && order.reduceVersion !== context.positionVersion)) return "stale";
  return "live";
}

const memory = new Map<string, number[]>();
const keyFor = (chain: number, engine: string, owner: string) => `eros-orders:${chain}:${engine.toLowerCase()}:${owner.toLowerCase()}`;

export function rememberedOrders(chain: number, engine: string, owner: string): number[] {
  const key = keyFor(chain, engine, owner);
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(value)) return [...new Set([...(memory.get(key) ?? []), ...value.filter((n): n is number => Number.isInteger(n) && n > 0 && n <= 0xffffffff)])];
  } catch { /* Private browsing/storage restrictions: keep this session's receipts. */ }
  return memory.get(key) ?? [];
}

export function rememberOrders(chain: number, engine: string, owner: string, ids: number[]) {
  const key = keyFor(chain, engine, owner);
  const all = [...new Set([...rememberedOrders(chain, engine, owner), ...ids])].slice(-5000);
  memory.set(key, all);
  try { localStorage.setItem(key, JSON.stringify(all)); } catch { /* In-memory fallback above. */ }
}
