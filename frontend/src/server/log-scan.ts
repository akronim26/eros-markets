import { createPublicClient, http, type Address, type Hex } from "viem";
import { chain } from "@/config/chain";

/** Server-only chunked eth_getLogs over one authenticated endpoint (public fallbacks cap ranges at 10-100 blocks). */
export type RawLog = { address: string; blockNumber: Hex; blockTimestamp?: Hex; logIndex: Hex; transactionHash: Hex; data: Hex; topics: [Hex, ...Hex[]]; removed?: boolean };
const MAX_CHUNK = 10_000n, MIN_CHUNK = 100n;

let rpc: ReturnType<typeof createPublicClient> | undefined;
export function client() {
  const url = process.env.MONAD_RPC_URL;
  if (!url) throw new Error("MONAD_RPC_URL is not configured for stored history.");
  rpc ??= createPublicClient({ chain, transport: http(url, { timeout: 20000, retryCount: 2, retryDelay: 750 }) });
  return rpc;
}

async function logs(filter: { address: Address[]; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<RawLog[]> {
  const result = await client().request({ method: "eth_getLogs", params: [{ address: filter.address, topics: filter.topics,
    fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] } as never) as unknown as RawLog[];
  if (!Array.isArray(result)) throw new Error("RPC returned invalid logs.");
  const allowed = new Set(filter.address.map((a) => a.toLowerCase()));
  for (const l of result) {
    const block = BigInt(l.blockNumber);
    if (!allowed.has(l.address.toLowerCase()) || block < from || block > to || l.removed) throw new Error("RPC returned logs outside the requested range.");
  }
  return result;
}

/** All matching logs in [from, to], in chunks; shrinks the chunk when an endpoint reports a range limit. */
export async function scanLogs(filter: { address: Address[]; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let chunk = MAX_CHUNK;
  for (let start = from; start <= to;) {
    const end = start + chunk - 1n < to ? start + chunk - 1n : to;
    try { out.push(...await logs(filter, start, end)); }
    catch (error) {
      if (chunk > MIN_CHUNK && /range|limit|too large|exceed/i.test(String((error as Error).message))) { chunk /= 4n; continue; }
      throw error;
    }
    start = end + 1n;
  }
  return out;
}

/** Block timestamps for logs; uses the log's blockTimestamp when the endpoint provides it. */
export async function logTimes(raw: RawLog[]): Promise<Map<bigint, bigint>> {
  const times = new Map<bigint, bigint>();
  for (const l of raw) if (l.blockTimestamp) times.set(BigInt(l.blockNumber), BigInt(l.blockTimestamp));
  const missing = [...new Set(raw.map((l) => BigInt(l.blockNumber)).filter((n) => !times.has(n)))];
  for (const [n, t] of await Promise.all(missing.map(async (n) => [n, (await client().getBlock({ blockNumber: n })).timestamp] as const))) times.set(n, t);
  return times;
}
