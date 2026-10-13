import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOriginRpcRequest, parseRpcRequests, sanitizeRpcResponse, readRpcBody } from "../src/lib/rpc-proxy.ts";

test("streamed RPC bodies have a total deadline and cancel stalled readers", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const input = new Request("http://localhost/api/rpc", { method: "POST", body, duplex: "half" });
  await assert.rejects(readRpcBody(input, { timeoutMs: 20 }), error => error.status === 408);
  assert.equal(cancelled, true);
});

test("streamed RPC limits apply without Content-Length and valid bodies still parse", async () => {
  const make = text => new Request("http://localhost/api/rpc", { method: "POST", body: text });
  await assert.rejects(readRpcBody(make("12345"), { maxBytes: 4 }), error => error.status === 413);
  assert.deepEqual(await readRpcBody(make('{"jsonrpc":"2.0"}')), { jsonrpc: "2.0" });
  await assert.rejects(readRpcBody(make("{")), error => error.status === 400);
});

test("RPC origin checks use the browser's host when Next binds all interfaces", () => {
  const request = (origin, extra = {}) => new Request("http://0.0.0.0:3100/api/rpc", { headers: { host: "localhost:3100", origin, ...extra } });
  assert.equal(isSameOriginRpcRequest(request("http://localhost:3100")), true);
  for (const origin of ["http://attacker.example", "http://localhost:3000", "null", "http://localhost:3100/path", "https://localhost:3100"])
    assert.equal(isSameOriginRpcRequest(request(origin)), false);
  assert.equal(isSameOriginRpcRequest(request("https://markets.example", { host: "markets.example", "x-forwarded-proto": "https" })), true);
  assert.equal(isSameOriginRpcRequest(new Request("http://localhost:3100/api/rpc")), true);
});

const request = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ data: "0x" }, "0x123"] };
test("RPC proxy accepts pinned reads and rejects sends, signing, admin calls and oversized batches", () => {
  assert.deepEqual(parseRpcRequests(request), [request]);
  assert.deepEqual(parseRpcRequests({ jsonrpc: "2.0", id: 0, method: "eth_chainId" })[0].params, []);
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "debug_traceCall", "admin_nodeInfo"])
    assert.throws(() => parseRpcRequests({ ...request, method }));
  for (const body of [[], Array(33).fill(request), null, { ...request, params: {} }, { ...request, id: null }])
    assert.throws(() => parseRpcRequests(body));
});
test("RPC errors preserve revert bytes while removing provider messages and credentials", () => {
  const response = sanitizeRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "https://private.example/secret", data: "0xdeadbeef" } }, [request], false);
  assert.equal(response.error.data, "0xdeadbeef");
  assert.equal(JSON.stringify(response).includes("secret"), false);
  const hidden = sanitizeRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32603, data: { url: "secret" } } }, [request], false);
  assert.equal("data" in hidden.error, false);
});
test("RPC proxy checks response identities and accepts out-of-order batch responses", () => {
  const two = { ...request, id: 2 };
  const responses = [{ jsonrpc: "2.0", id: 2, result: null }, { jsonrpc: "2.0", id: 1, result: "0x01" }];
  assert.deepEqual(sanitizeRpcResponse(responses, [request, two], true), responses);
  assert.throws(() => sanitizeRpcResponse(responses.slice(0, 1), [request], false));
  assert.throws(() => sanitizeRpcResponse([responses[0], responses[0]], [request, two], true));
});
