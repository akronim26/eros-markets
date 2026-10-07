import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../../src/app/api/rpc/route";

test("unfinished uploads release every RPC slot after the body deadline", async () => {
  let cancelled = 0;
  const hanging = () => new Request("http://localhost/api/rpc", {
    method: "POST", body: new ReadableStream({ cancel() { cancelled++; } }), duplex: "half",
  } as RequestInit & { duplex: "half" });
  const calls = Array.from({ length: 6 }, () => POST(hanging()));
  const invalid = () => new Request("http://localhost/api/rpc", { method: "POST", body: "{}" });
  assert.equal((await POST(invalid())).status, 429);
  const replies = await Promise.all(calls);
  assert.ok(replies.every(reply => reply.status === 408));
  assert.equal(cancelled, 6);
  // Reaching body validation proves the slot is available, without an upstream call.
  assert.equal((await POST(invalid())).status, 400);
});
