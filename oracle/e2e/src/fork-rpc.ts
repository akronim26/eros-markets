/** A read-only upstream RPC boundary for local Anvil forks. Even if the fork
 * requests an unexpected signing or mutation method, it cannot reach upstream. */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rpcTransport } from './integrated-preflight.js'

export function forkRpcHandler(endpoint: string, record: (method: string, success: boolean) => void) {
  const upstream = rpcTransport(endpoint)
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/') return new Response('Not found', { status: 404 })
    let id: unknown = null
    let method = 'invalid-request'
    try {
      const input = await request.json() as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }
      if (Array.isArray(input) || input.jsonrpc !== '2.0' || typeof input.method !== 'string') throw new Error('Invalid RPC request')
      id = input.id ?? null
      method = input.method
      const result = await upstream.request({ method, params: input.params })
      record(method, true)
      return Response.json({ jsonrpc: '2.0', id, result })
    } catch {
      record(method, false)
      // Do not return upstream URLs, API credentials or full payloads in errors.
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Read-only fork RPC request rejected or failed' } })
    }
  }
}

if (import.meta.main) {
  const [portInput, outputInput] = process.argv.slice(2)
  const port = Number(portInput)
  const endpoint = process.env.INTEGRATED_PREFLIGHT_RPC
  if (!endpoint || !Number.isInteger(port) || port < 1024 || port > 65535 || !outputInput) throw new Error('Usage: fork-rpc.ts <loopback port> <tmp/audit.json>, INTEGRATED_PREFLIGHT_RPC required')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const output = resolve(outputInput)
  const rel = relative(resolve(root, 'tmp'), output)
  if (rel.startsWith('..') || isAbsolute(rel) || !output.endsWith('.json')) throw new Error('Proxy audit must be inside repository tmp/')
  const audit = { schema: 'eros-read-only-fork-rpc/1', origin: new URL(endpoint).origin,
    endpointSha256: createHash('sha256').update(endpoint).digest('hex'), publicTransactions: 0,
    methods: Object.create(null) as Record<string, { accepted: number; failed: number }> }
  const save = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(audit, null, 2) + '\n') }
  const handler = forkRpcHandler(endpoint, (method, success) => {
    const result = audit.methods[method] ??= { accepted: 0, failed: 0 }
    result[success ? 'accepted' : 'failed']++
    save()
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler, maxRequestBodySize: 2 * 1024 * 1024 })
  save()
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${server.port}`, readOnly: true, audit: output }))
}
