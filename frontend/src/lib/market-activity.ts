/**
 * Visitor heartbeats that let the testnet supervisor wake a sleeping market. The value is only a
 * "last seen" time per listed engine: it never authorizes anything, and abuse can at most keep a
 * market awake. Stored in the Vercel Runtime Cache, which is per region, so the route pins one.
 */
export const ACTIVITY_TTL_SECONDS = 600;

export type ActivityCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number; name?: string }): Promise<void>;
};

const key = (engine: string) => `market-activity:${engine.toLowerCase()}`;

/** Accept only an exact listed engine; anything else is rejected without a write. */
export function parseHeartbeat(body: unknown, engines: readonly string[]): string | undefined {
  const engine = (body as { engine?: unknown } | null)?.engine;
  if (typeof engine !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(engine)) return undefined;
  return engines.find(e => e.toLowerCase() === engine.toLowerCase())?.toLowerCase();
}

export async function recordHeartbeat(cache: ActivityCache, engine: string, nowMs: number) {
  await cache.set(key(engine), nowMs, { ttl: ACTIVITY_TTL_SECONDS, name: "market-activity" });
}

export async function readActivity(cache: ActivityCache, engines: readonly string[]) {
  const rows = await Promise.all(engines.map(async engine => {
    const value = await cache.get(key(engine));
    return [engine.toLowerCase(), Number.isSafeInteger(value) ? value as number : null] as const;
  }));
  return { engines: Object.fromEntries(rows) };
}
