import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../../src/app/api/permissions/route";
import { privy } from "../../src/server/privy";

Object.assign(process.env, { NEXT_PUBLIC_PRIVY_APP_ID: "test-only-app", PRIVY_APP_SECRET: "test-only-secret",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: "test-only-key", PRIVY_TRADE_SIGNER_ID: "test-signer", PRIVY_POLICY_TRADE_ID: "test-policy" });

test("permissions route redacts plain SDK Error messages that contain upstream credentials", async (t) => {
  const upstream = "https://rpc.example/private-provider-token?authorization=test-private-request";
  t.mock.method(privy().utils().auth(), "verifyAccessToken", async () => { throw new Error(`Transport failed at ${upstream}`); });
  const response = await GET(new Request("https://app.test/api/permissions?wallet=0x1111111111111111111111111111111111111111", { headers: { authorization: "Bearer test-only" } }));
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.doesNotMatch(body, /private-provider-token|test-private-request|rpc\.example/);
  assert.match(body, /Check your login/);
});

test("permissions route keeps actionable application validation messages", async () => {
  const response = await GET(new Request("https://app.test/api/permissions"));
  assert.deepEqual(await response.json(), { error: "Log in again to continue." });
});
