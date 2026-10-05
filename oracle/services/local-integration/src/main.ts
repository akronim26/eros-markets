import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http, type Abi } from 'viem'
import { LocalReadModel, json, manifestSchema, type ReadClient } from './read-model'

const [manifestPath, command = 'serve', output] = process.argv.slice(2)
if (!manifestPath || !['serve', 'snapshot', 'events'].includes(command)) throw new Error('Usage: bun src/main.ts manifest.json [serve|snapshot|events] [output.json]')
const manifest = manifestSchema.parse(JSON.parse(readFileSync(resolve(manifestPath), 'utf8')))
const artifact = (name: string): Abi => JSON.parse(readFileSync(new URL(`../../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi
const abis = { engine: artifact('RegistryBookRiskEngine'), vault: artifact('CollateralVault'), token: artifact('MockUSDC'),
  oracle: artifact('ResolutionOracle'), registry: artifact('MarketRegistry') }
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
  const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    const origin = request.headers.get('Origin')
    if (origin) {
      const allowed = /^http:\/\/(localhost|127\.0\.0\.1):(3000|5173|8787)$/.test(origin)
      if (!allowed) return new Response(json({ error: 'ORIGIN_NOT_ALLOWED' }), { status: 403, headers })
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
    }
    if (request.method !== 'GET') return new Response(json({ error: 'READ_ONLY' }), { status: 405, headers })
    try {
      const url = new URL(request.url)
      const route = url.pathname
      if (route === '/manifest') return new Response(json(manifest), { headers })
      if (route === '/snapshot' || route === '/health') return new Response(json(await model.snapshot()), { headers })
      if (route === '/events') {
        const from = url.searchParams.get('fromBlock') ?? String(Math.min(...manifest.markets.map(market => market.deployBlock)))
        if (!/^(0|[1-9][0-9]*)$/.test(from)) throw new Error('INVALID_FROM_BLOCK')
        return new Response(json(await model.events(BigInt(from))), { headers })
      }
      if (route.startsWith('/abi/')) {
        const key = route.slice(5) as keyof typeof abis
        if (Object.hasOwn(abis, key)) return new Response(json(abis[key]), { headers })
      }
      return new Response(json({ error: 'NOT_FOUND' }), { status: 404, headers })
    } catch {
      return new Response(json({ error: 'LOCAL_READ_UNAVAILABLE', detail: 'Check local chain, manifest identity and bounded query range; no zero balances are substituted.' }), { status: 503, headers })
    }
  } })
  console.log(json({ scope: 'local-only', readOnly: true, address: `http://127.0.0.1:${server.port}`, chainId: 31337 }))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(); process.exit(0) })
}
