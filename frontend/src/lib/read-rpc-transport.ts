import { custom, http, type EIP1193RequestFn } from 'viem';
import { createReadPool, readPoolEndpoints, writerLane, type PoolRequest } from '../../../packages/pricefeed/src/read-pool';

const cachedTransports = new Map<string, ReturnType<typeof custom>>();

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
  const send = async (url: string, request: PoolRequest) => {
    const transport = noBatch.has(url) ? singles.get(url)! : transports.get(url)!;
    try { return await transport.request(request as Parameters<EIP1193RequestFn>[0]); }
    catch (error) {
      const e = error as { code?: number; status?: number };
      if (noBatch.has(url) || e.code !== -32600 && e.code !== -32602 && e.status !== 400) throw error;
      noBatch.add(url);
      return singles.get(url)!.request(request as Parameters<EIP1193RequestFn>[0]);
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
