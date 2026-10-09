import { custom, http, type EIP1193RequestFn } from 'viem'
import { createReadPool, readPoolEndpoints } from '../../../../packages/pricefeed/src/read-pool'

const cachedTransports = new Map<string, ReturnType<typeof custom>>()

/** Public state and confirmation reads only. Sender nonce/simulation/broadcast stay separate. */
export function marketReadTransport(rpcUrl: string, chainId = 10143) {
  if (chainId !== 10143) return http(rpcUrl, { batch: { batchSize: 8, wait: 16 }, retryCount: 1 })
  const endpoints = readPoolEndpoints(rpcUrl, process.env.MONAD_READ_FALLBACK_URLS, process.env.MONAD_READ_RPC_CAPACITIES)
  const key = JSON.stringify([chainId, endpoints]), cached = cachedTransports.get(key)
  if (cached) return cached
  const batch = new Map(endpoints.map(({ url }) => [url, http(url, {
    batch: { batchSize: 8, wait: 8 }, timeout: 2500, retryCount: 0, fetchOptions: { redirect: 'error' },
  })({})]))
  const singles = new Map(endpoints.map(({ url }) => [url, http(url, {
    timeout: 2500, retryCount: 0, fetchOptions: { redirect: 'error' },
  })({})]))
  const noBatch = new Set<string>()
  const pool = createReadPool({ endpoints, chainId, request: async (url, request) => {
    const transport = noBatch.has(url) ? singles.get(url)! : batch.get(url)!
    try { return await transport.request(request as Parameters<EIP1193RequestFn>[0]) }
    catch (error) {
      const e = error as { code?: number; status?: number }
      if (noBatch.has(url) || e.code !== -32600 && e.code !== -32602 && e.status !== 400) throw error
      noBatch.add(url)
      return singles.get(url)!.request(request as Parameters<EIP1193RequestFn>[0])
    }
  } })
  const transport = custom({ request: ({ method, params }) => pool.request({ method, params: params as readonly unknown[] }) },
    { key: 'market-ops-read-pool', retryCount: 0 })
  cachedTransports.set(key, transport)
  if (cachedTransports.size > 8) cachedTransports.delete(cachedTransports.keys().next().value!)
  return transport
}
