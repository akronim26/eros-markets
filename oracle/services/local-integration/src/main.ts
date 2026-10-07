import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, erc20Abi, http, type Address } from 'viem'
import { RegistryBookRiskEngineAbi, CollateralVaultAbi, ResolutionOracleAbi, MarketRegistryAbi, MarketFactoryAbi } from '../../../packages/oracle-sdk/src/browser'
import { LocalReadModel, json, readManifestSchema, type Abis, type ReadClient } from './read-model'

export const defaultOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3100', 'http://127.0.0.1:3100', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787']

export function readHandler(model: LocalReadModel, abis: Abis, origins: readonly string[] = defaultOrigins) {
  const allowedOrigins = new Set(origins.map(value => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('INVALID_ALLOWED_ORIGIN')
    return value
  }))
  return async (request: Request) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    const origin = request.headers.get('Origin')
    if (origin) {
      if (!allowedOrigins.has(origin)) return new Response(json({ error: 'ORIGIN_NOT_ALLOWED' }), { status: 403, headers })
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
    }
    if (request.method !== 'GET') return new Response(json({ error: 'READ_ONLY' }), { status: 405, headers })
    try {
      const url = new URL(request.url)
      const route = url.pathname
      if (route === '/manifest') return new Response(json(model.publicManifest()), { headers })
      if (route === '/snapshot' || route === '/health') {
        const owners = url.searchParams.getAll('owner')
        if (owners.length > 16 || owners.some(owner => !/^0x[0-9a-fA-F]{40}$/.test(owner))) {
          return new Response(json({ error: 'INVALID_OWNER_QUERY', detail: 'Use up to 16 owner address parameters.' }), { status: 400, headers })
        }
        return new Response(json(await model.snapshot(owners.length ? owners as Address[] : undefined)), { headers })
      }
      if (route === '/events') {
        const from = url.searchParams.get('fromBlock') ?? String(Math.min(...model.manifest.markets.map(market => market.deployBlock)))
        if (!/^(0|[1-9][0-9]*)$/.test(from) || from.length > 20) return new Response(json({ error: 'INVALID_FROM_BLOCK' }), { status: 400, headers })
        return new Response(json(await model.events(BigInt(from))), { headers })
      }
      if (route.startsWith('/abi/')) {
        const key = route.slice(5) as keyof Abis
        if (Object.hasOwn(abis, key) && abis[key]) return new Response(json(abis[key]), { headers })
      }
      return new Response(json({ error: 'NOT_FOUND' }), { status: 404, headers })
    } catch {
      // Transport errors may contain private RPC URLs. Only controlled public errors leave this boundary.
      return new Response(json({ error: 'READ_UNAVAILABLE', detail: 'Check chain, manifest identity and bounded query range; no zero balances are substituted.' }), { status: 503, headers })
    }
  }
}

if (import.meta.main) {
  const [manifestPath, command = 'serve', output] = process.argv.slice(2)
  if (!manifestPath || !['serve', 'snapshot', 'events'].includes(command)) throw new Error('Usage: bun src/main.ts manifest.json [serve|snapshot|events] [output.json]')
  const manifest = readManifestSchema.parse(JSON.parse(readFileSync(resolve(manifestPath), 'utf8')))
  const abis = { engine: RegistryBookRiskEngineAbi, vault: CollateralVaultAbi, token: erc20Abi,
    oracle: ResolutionOracleAbi, registry: MarketRegistryAbi, factory: MarketFactoryAbi }
  const client = createPublicClient({ transport: http(manifest.rpcUrl, { timeout: 5000, retryCount: 0, fetchOptions: { redirect: 'error' } }) })
  const model = new LocalReadModel(manifest, abis, client as unknown as ReadClient)
  if (command !== 'serve') {
    const result = command === 'snapshot' ? await model.snapshot() : await model.events(BigInt(Math.min(...manifest.markets.map(market => market.deployBlock))))
    if (output) writeFileSync(resolve(output), json(result) + '\n')
    else console.log(json(result))
  } else {
    await model.snapshot()
    const port = Number(process.env.LOCAL_READ_PORT ?? '8787')
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid LOCAL_READ_PORT')
    const origins = process.env.READ_ALLOWED_ORIGINS?.split(',').map(value => value.trim()) ?? defaultOrigins
    const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: readHandler(model, abis, origins) })
    console.log(json({ scope: manifest.scope, readOnly: true, address: `http://127.0.0.1:${server.port}`, chainId: manifest.chainId }))
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(); process.exit(0) })
  }
}
