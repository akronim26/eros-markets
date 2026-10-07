import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../src/server/store";
import { insertProtectionRule } from "../../src/server/protection-rule-store";
import { jsonBody } from "../../src/server/privy";

const directory = mkdtempSync(join(tmpdir(), "eros-protection-limits-"));
process.env.AUTOMATION_DB = join(directory, "rules.sqlite");
after(() => { db().close(); rmSync(directory, { recursive: true, force: true }); });

test("concurrent completed preflights cannot exceed the rule limit; unresolved rules count until reconciled", async () => {
  const rule = (id: number) => ({ id: String(id), user: "alice", wallet: "0xAA", engine: "0xBB", body: "{}", created: Date.now() });
  const attempts = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => Promise.resolve().then(() => insertProtectionRule(rule(i)))));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 20);
  assert.equal((db().prepare("SELECT count(*) AS n FROM rules").get() as { n: number }).n, 20);
  db().prepare("UPDATE rules SET status='uncertain' WHERE id='0'").run();
  assert.throws(() => insertProtectionRule(rule(25)), /unresolved protection rules/);
  db().prepare("UPDATE rules SET status='cancelled' WHERE id='1'").run();
  insertProtectionRule(rule(25));
  assert.equal((db().prepare("SELECT wallet FROM rules WHERE id='25'").get() as { wallet: string }).wallet, "0xaa");
});

test("authenticated API uploads time out and cancel stalled producers", async () => {
  let cancelled = false;
  const request = new Request("https://eros.test/api/protection", {
    method: "POST", headers: { origin: "https://eros.test" },
    body: new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(jsonBody(request, 10), /timed out/);
  assert.equal(cancelled, true);
});

test("bounded authenticated bodies retain JSON parsing and same-origin enforcement", async () => {
  const request = (body: string, origin = "https://eros.test") => new Request("https://eros.test/api/trade", { method: "POST", headers: { origin }, body });
  assert.deepEqual(await jsonBody(request('{"action":"cancel"}')), { action: "cancel" });
  await assert.rejects(jsonBody(request("x".repeat(12001))), /too large/);
  await assert.rejects(jsonBody(request("{}", "https://other.test")), /origin/);
});
