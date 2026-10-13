import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST } from '../../src/app/api/rpc/route';

type Wire = { jsonrpc: string; id: number; method: string; params: unknown[] };
const hash = '0x' + 'ab'.repeat(32);

test('RPC proxy fails over throttled reads, preserves batch IDs, and hides upstream credentials', async () => {
  const oldFetch = globalThis.fetch;
  const before = { primary: process.env.MONAD_RPC_URL, fallbacks: process.env.MONAD_FRONTEND_READ_FALLBACK_URLS };
  process.env.MONAD_RPC_URL = 'https://frontend-primary.invalid/private-token';
  process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = 'https://frontend-backup.invalid/other-token';
  const hosts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const host = new URL(String(input)).hostname; hosts.push(host);
    if (host === 'frontend-primary.invalid') return new Response('secret upstream', { status: 429 });
    const body = JSON.parse(String(init?.body));
    const respond = (r: Wire) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x279f'
      : r.method === 'eth_getBlockByNumber' ? { number: '0xa', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), transactions: [] }
      : '0x6000' });
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  };
  try {
    const response = await POST(new Request('http://localhost/api/rpc', { method: 'POST', body: JSON.stringify([
      { jsonrpc: '2.0', id: 51, method: 'eth_getCode', params: ['0x' + '11'.repeat(20), 'latest'] },
      { jsonrpc: '2.0', id: 52, method: 'eth_getCode', params: ['0x' + '22'.repeat(20), 'latest'] },
    ]) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ jsonrpc: '2.0', id: 51, result: '0x6000' }, { jsonrpc: '2.0', id: 52, result: '0x6000' }]);
    assert.ok(hosts.includes('frontend-primary.invalid') && hosts.includes('frontend-backup.invalid'));
  } finally {
    globalThis.fetch = oldFetch;
    if (before.primary === undefined) delete process.env.MONAD_RPC_URL; else process.env.MONAD_RPC_URL = before.primary;
    if (before.fallbacks === undefined) delete process.env.MONAD_FRONTEND_READ_FALLBACK_URLS; else process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = before.fallbacks;
  }
});

test('RPC proxy keeps simulation and nonce reads on the writer and preserves revert data', async () => {
  const oldFetch = globalThis.fetch;
  const before = { primary: process.env.MONAD_RPC_URL, fallbacks: process.env.MONAD_FRONTEND_READ_FALLBACK_URLS };
  process.env.MONAD_RPC_URL = 'https://writer.invalid/private-key';
  process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = 'https://unused.invalid/private-key';
  const calls: { host: string; method: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const host = new URL(String(input)).hostname, body = JSON.parse(String(init?.body));
    const respond = (r: Wire) => {
      calls.push({ host, method: r.method });
      return r.method === 'eth_estimateGas' ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'https://writer.invalid/private-key', data: '0x8523b62a' } }
        : { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x279f' : '0x5' };
    };
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  };
  try {
    const response = await POST(new Request('http://localhost/api/rpc', { method: 'POST', body: JSON.stringify([
      { jsonrpc: '2.0', id: 61, method: 'eth_getTransactionCount', params: ['0x' + '11'.repeat(20), 'pending'] },
      { jsonrpc: '2.0', id: 62, method: 'eth_estimateGas', params: [{ to: '0x' + '22'.repeat(20) }] },
    ]) }));
    const body = await response.text();
    assert.ok(!body.includes('private-key') && !body.includes('writer.invalid'));
    assert.deepEqual(JSON.parse(body), [{ jsonrpc: '2.0', id: 61, result: '0x5' },
      { jsonrpc: '2.0', id: 62, error: { code: 3, message: 'Upstream RPC request failed', data: '0x8523b62a' } }]);
    assert.ok(calls.every(c => c.host === 'writer.invalid'));
  } finally {
    globalThis.fetch = oldFetch;
    if (before.primary === undefined) delete process.env.MONAD_RPC_URL; else process.env.MONAD_RPC_URL = before.primary;
    if (before.fallbacks === undefined) delete process.env.MONAD_FRONTEND_READ_FALLBACK_URLS; else process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = before.fallbacks;
  }
});

test('a healthy read fallback cannot authorize writer reads on a wrong-chain primary', async () => {
  const oldFetch = globalThis.fetch;
  const before = { primary: process.env.MONAD_RPC_URL, fallbacks: process.env.MONAD_FRONTEND_READ_FALLBACK_URLS };
  process.env.MONAD_RPC_URL = 'https://wrong-writer.invalid';
  process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = 'https://correct-reader.invalid';
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const host = new URL(String(input)).hostname, body = JSON.parse(String(init?.body));
    const respond = (r: Wire) => {
      methods.push(r.method);
      return { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId'
        ? host === 'wrong-writer.invalid' ? '0x1' : '0x279f'
        : { number: '0xa', hash, timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), transactions: [] } };
    };
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  };
  try {
    const send = (id: number, method: string, params: unknown[] = []) => POST(new Request('http://localhost/api/rpc', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }));
    assert.deepEqual(await (await send(71, 'eth_chainId')).json(), { jsonrpc: '2.0', id: 71, result: '0x279f' });
    const denied = await (await send(72, 'eth_getTransactionCount', ['0x' + '11'.repeat(20), 'pending'])).json();
    assert.ok(denied.error);
    assert.equal(methods.includes('eth_getTransactionCount'), false);
  } finally {
    globalThis.fetch = oldFetch;
    if (before.primary === undefined) delete process.env.MONAD_RPC_URL; else process.env.MONAD_RPC_URL = before.primary;
    if (before.fallbacks === undefined) delete process.env.MONAD_FRONTEND_READ_FALLBACK_URLS; else process.env.MONAD_FRONTEND_READ_FALLBACK_URLS = before.fallbacks;
  }
});
