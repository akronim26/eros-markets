import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonBody } from "../../src/server/privy";

test("authenticated API bodies accept the browser origin when Next uses a bind address", async () => {
  const request = (origin: string, extra: Record<string, string> = {}) => new Request("http://0.0.0.0:3100/api/trade", {
    method: "POST", headers: { host: "localhost:3100", origin, ...extra }, body: '{"action":"cancelAll"}',
  });
  assert.deepEqual(await jsonBody(request("http://localhost:3100")), { action: "cancelAll" });
  assert.deepEqual(await jsonBody(request("https://markets.example", { host: "markets.example", "x-forwarded-proto": "https" })), { action: "cancelAll" });
  await assert.rejects(jsonBody(request("https://attacker.example")), /Invalid request origin/);
});
