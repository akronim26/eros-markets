import { custom, http, type EIP1193RequestFn } from 'viem';
import { createReadPool, readPoolEndpoints, writerLane, type PoolRequest } from '../../../packages/pricefeed/src/read-pool';

const cachedTransports = new Map<string, ReturnType<typeof custom>>();
const hexNumber = (value: unknown): value is string => typeof value === 'string' && /^0x[\da-f]{1,16}$/i.test(value);
function boundedLogRange(request: PoolRequest) {
  if (request.method !== 'eth_getLogs' || request.params?.length !== 1) return;
  const filter = request.params[0] as Record<string, unknown> | undefined;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) || 'blockHash' in filter
    || !hexNumber(filter.fromBlock) || !hexNumber(filter.toBlock)) return;
  const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
  if (to < from || to - from >= 100n) return;
  return { filter, from, to };
}
function advertisedLogRange(error: unknown): bigint | undefined {
  let current = error, supportedError = false, limit: bigint | undefined;
  for (let i = 0; current && typeof current === 'object' && i < 8; i++) {
    const e = current as { code?: number; status?: number; message?: string; data?: unknown; cause?: unknown };
    // A contract revert is never a capability hint, even if its text resembles one.
    if (e.code === 3 || e.code === -32000 || typeof e.data === 'string' && /^0x[\da-f]{8,}$/i.test(e.data)) return;
    supportedError ||= e.code === -32600 || e.status === 400;
    const match = e.message?.match(/eth_getLogs requests with up to a (\d{1,3}) block range/i);
    if (match) limit = BigInt(match[1]);
    current = e.cause;
  }
  return supportedError && limit !== undefined && limit > 0n && limit < 100n ? limit : undefined;
}
function validChunkLog(value: unknown, from: bigint, to: bigint): boolean {
  const log = value as Record<string, unknown> | undefined;
  const hash = (v: unknown) => typeof v === 'string' && /^0x[\da-f]{64}$/i.test(v);
  return !!log && typeof log === 'object' && !Array.isArray(log)
    && hexNumber(log.blockNumber) && BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to
    && hash(log.blockHash) && hash(log.transactionHash) && hexNumber(log.logIndex) && hexNumber(log.transactionIndex)
    && typeof log.address === 'string' && /^0x[\da-f]{40}$/i.test(log.address)
    && typeof log.data === 'string' && /^0x(?:[\da-f]{2})*$/i.test(log.data)
    && Array.isArray(log.topics) && log.topics.every(hash) && typeof log.removed === 'boolean';
}

/** Invoke with private configuration on the server only; browser traffic uses /api/rpc. */
export function pooledReadTransport(primary: string, fallbacks = '', capacities = '', chainId = 10143) {
  const endpoints = readPoolEndpoints(primary, fallbacks, capacities);
  const key = JSON.stringify([chainId, endpoints]), cached = cachedTransports.get(key);
  if (cached) return cached;
  const transports = new Map(endpoints.map(({ url }) => [url, http(url, {
    batch: { batchSize: 8, wait: 8 }, timeout: 2500, retryCount: 0,
    fetchOptions: { redirect: 'error', cache: 'no-store' },
  })({})]));
  const singles = new Map(endpoints.map(({ url }) => [url, http(url, {
    batch: false, timeout: 2500, retryCount: 0, fetchOptions: { redirect: 'error', cache: 'no-store' },
  })({})]));
  const noBatch = new Set<string>();
  const logLimits = new Map<string, bigint>();
  const direct = async (url: string, request: PoolRequest) => {
    const transport = noBatch.has(url) ? singles.get(url)! : transports.get(url)!;
    try { return await transport.request(request as Parameters<EIP1193RequestFn>[0]); }
    catch (error) {
      const e = error as { code?: number; status?: number };
      if (noBatch.has(url) || e.code !== -32600 && e.code !== -32602 && e.status !== 400) throw error;
      noBatch.add(url);
      return singles.get(url)!.request(request as Parameters<EIP1193RequestFn>[0]);
    }
  };
  const send = async (url: string, request: PoolRequest) => {
    const range = boundedLogRange(request), known = logLimits.get(url), deadline = Date.now() + 2500;
    const splittable = (limit: bigint) => !!range && range.to - range.from + 1n > limit
      && (range.to - range.from + limit) / limit <= 10n;
    const chunks = async (limit: bigint) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('Log read timed out', 'TimeoutError');
      // One deadline covers the whole sequence; each request remains inside the
      // existing endpoint timeout. Never expose an incomplete set of logs.
      const signal = AbortSignal.timeout(remaining), logs: unknown[] = [];
      for (let from = range!.from; from <= range!.to; from += limit) {
        signal.throwIfAborted();
        const to = from + limit - 1n < range!.to ? from + limit - 1n : range!.to;
        const result = await singles.get(url)!.request({ method: 'eth_getLogs', params: [{ ...range!.filter,
          fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] }, { signal });
        signal.throwIfAborted();
        if (!Array.isArray(result) || result.some(log => !validChunkLog(log, from, to))) throw new Error('RPC_LOG_CHUNK_INVALID');
        logs.push(...result);
      }
      logLimits.set(url, limit);
      return logs;
    };
    if (known !== undefined && splittable(known)) return chunks(known);
    try { return await direct(url, request); }
    catch (error) {
      const limit = advertisedLogRange(error);
      if (limit === undefined || !splittable(limit)) throw error;
      return chunks(limit);
    }
  };
  const pool = createReadPool({ endpoints, chainId, request: send });
  let writerCheckedAt = 0, writerCheck: Promise<void> | undefined;
  const verifyWriter = async () => {
    if (Date.now() - writerCheckedAt < 5000) return;
    writerCheck ??= send(primary, { method: 'eth_chainId' }).then(value => {
      if (value !== `0x${chainId.toString(16)}`) throw new Error('RPC_WRITER_WRONG_CHAIN');
      writerCheckedAt = Date.now();
    }).finally(() => { writerCheck = undefined; });
    await writerCheck;
  };
  const transport = custom({ request: ({ method, params }) => {
    const request = { method, params: params as readonly unknown[] };
    // A preview/pending nonce remains on the same configured writer lane.
    return writerLane(request) ? verifyWriter().then(() => send(primary, request)) : pool.request(request);
  } }, { key: 'verified-read-pool', retryCount: 0 });
  cachedTransports.set(key, transport);
  if (cachedTransports.size > 8) cachedTransports.delete(cachedTransports.keys().next().value!);
  return transport;
}
