import { expect, test } from 'bun:test'
import { forkRpcHandler } from '../src/fork-rpc.js'

test('fork proxy forwards permitted reads and never forwards signing or mutations', async () => {
  const forwarded: string[] = []
  const records: Array<[string, boolean]> = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const input = await request.json() as { method: string; id: number }
    forwarded.push(input.method)
    return Response.json({ jsonrpc: '2.0', id: input.id, result: '0x279f' })
  } })
  try {
    const handle = forkRpcHandler(`http://127.0.0.1:${upstream.port}`, (method, success) => records.push([method, success]))
    const request = (method: string) => new Request('http://127.0.0.1:18582/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: [] }) })
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'anvil_setBalance', 'evm_revert']) {
      expect((await (await handle(request(method))).json()).error.code).toBe(-32601)
    }
    expect(forwarded).toEqual([])
    expect((await (await handle(request('eth_chainId'))).json()).result).toBe('0x279f')
    expect(forwarded).toEqual(['eth_chainId'])
    expect(records).toHaveLength(7)
    expect(records.at(-1)).toEqual(['eth_chainId', true])
  } finally { await upstream.stop(true) }
})

test('fork proxy refuses batching and non-POST endpoints without forwarding', async () => {
  const records: Array<[string, boolean]> = []
  const handle = forkRpcHandler('http://127.0.0.1:1', (method, success) => records.push([method, success]))
  expect((await handle(new Request('http://127.0.0.1/'))).status).toBe(404)
  const batch = new Request('http://127.0.0.1/', { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }]) })
  expect((await (await handle(batch)).json()).error.code).toBe(-32601)
  expect(records).toEqual([['invalid-request', false]])
})
