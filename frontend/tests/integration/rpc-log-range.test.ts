import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { pooledReadTransport } from '../../src/lib/read-rpc-transport';

type Wire = { id: number; method: string; params: any[] };
const address = '0x' + '11'.repeat(20), hash = '0x' + 'ab'.repeat(32);
const filter = { address: [address], topics: [hash, null, [hash]], fromBlock: '0x1', toBlock: '0x64' };
const rangeMessage = 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.';
let fixture = 0;
const log = (block: bigint) => ({ address, blockNumber: `0x${block.toString(16)}`, blockHash: hash,
  transactionHash: hash, logIndex: '0x0', transactionIndex: '0x0', data: '0x', topics: [hash], removed: false });
function reader(t: TestContext, answer: (r: Wire, signal?: AbortSignal | null) => any | Promise<any>) {
  const requests: Wire[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body));
    const respond = async (r: Wire) => {
      if (r.method === 'eth_getLogs') { requests.push(r); return { jsonrpc: '2.0', id: r.id, ...await answer(r, init?.signal) }; }
      return { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x279f'
        : { number: '0x100', hash, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, transactions: [] } };
    };
    return Response.json(Array.isArray(body) ? await Promise.all(body.map(respond)) : await respond(body));
  });
  const transport = pooledReadTransport(`https://log-range-${++fixture}.invalid`)({});
  return { requests, send: (value: Record<string, unknown> = filter) => transport.request({ method: 'eth_getLogs', params: [value] }) };
}
const limited = (r: Wire) => BigInt(r.params[0].toBlock) - BigInt(r.params[0].fromBlock) >= 10n;
const success = (r: Wire) => ({ result: Array.from({ length: Number(BigInt(r.params[0].toBlock) - BigInt(r.params[0].fromBlock) + 1n) },
  (_, i) => log(BigInt(r.params[0].fromBlock) + BigInt(i))) });
const limitError = { error: { code: -32600, message: rangeMessage } };

test('known provider limit splits the inclusive range exactly and preserves filters', async t => {
  const r = reader(t, request => limited(request) ? limitError : success(request));
  const original = structuredClone(filter), result = await r.send();
  assert.deepEqual(filter, original); assert.equal(result.length, 100);
  assert.deepEqual(result.map((l: any) => BigInt(l.blockNumber)), Array.from({ length: 100 }, (_, i) => BigInt(i + 1)));
  const chunks = r.requests.filter(request => !limited(request)); assert.equal(chunks.length, 10);
  for (const [i, chunk] of chunks.entries()) assert.deepEqual(chunk.params[0], { ...filter,
    fromBlock: `0x${(i * 10 + 1).toString(16)}`, toBlock: `0x${(i * 10 + 10).toString(16)}` });
  r.requests.length = 0; await r.send({ ...filter, toBlock: '0xb' });
  assert.deepEqual(r.requests.map(request => [request.params[0].fromBlock, request.params[0].toBlock]), [['0x1', '0xa'], ['0xb', '0xb']],
    'reuse successful endpoint capability without repeating unsupported requests');
});

test('generic invalid requests and contract revert bytes never authorize splitting', async t => {
  for (const error of [{ code: -32600, message: 'Invalid request' }, { code: 3, message: rangeMessage, data: '0xdeadbeef' },
    { code: -32600, message: rangeMessage, data: '0xdeadbeef' }]) {
    const r = reader(t, () => ({ error })); await assert.rejects(r.send());
    assert.ok(r.requests.length <= 2);
    assert.ok(r.requests.every(request => request.params[0].fromBlock === filter.fromBlock && request.params[0].toBlock === filter.toBlock));
  }
});

test('moving tags, block hashes, reversed and oversized ranges remain untouched', async t => {
  const r = reader(t, () => limitError);
  for (const value of [{ ...filter, toBlock: 'latest' }, { ...filter, blockHash: hash }, { ...filter, fromBlock: '0x10', toBlock: '0xf' },
    { ...filter, toBlock: '0x65' }, { ...filter, fromBlock: 'garbage' }, { ...filter, fromBlock: 1 }]) {
    const before = r.requests.length; await assert.rejects(r.send(value));
    assert.ok(r.requests.slice(before).every(request => JSON.stringify(request.params[0]) === JSON.stringify(value)));
  }
});

test('failed or malformed chunks reject the entire request without later reads', async t => {
  for (const broken of [{ error: { code: -32600, message: 'Invalid third chunk' } }, { result: 'not logs' },
    { result: [{ ...log(21n), blockNumber: '0x1' }] }, { result: [{ ...log(21n), transactionHash: null }] }]) {
    const r = reader(t, request => limited(request) ? limitError : request.params[0].fromBlock === '0x15' ? broken : success(request));
    await assert.rejects(r.send()); assert.equal(r.requests.filter(request => !limited(request)).length, 3);
  }
});

test('whole chunk sequence shares one endpoint timeout and aborts the pending HTTP fetch', async t => {
  let aborted = 0;
  const r = reader(t, async (request, signal) => {
    if (limited(request)) return limitError;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      signal?.addEventListener('abort', () => { clearTimeout(timer); aborted++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    return success(request);
  });
  const start = performance.now(); await assert.rejects(r.send());
  assert.ok(performance.now() - start < 3500, 'ten chunks cannot each spend a separate 2.5s timeout');
  assert.ok(aborted > 0); assert.equal(r.requests.filter(request => !limited(request)).length, 3);
});
