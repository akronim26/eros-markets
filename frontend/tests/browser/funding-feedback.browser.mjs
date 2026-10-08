// From frontend/: node --test tests/browser/funding-feedback.browser.mjs
// Uses the real useTx, TxFeedback, wallet guard and canonical finality checks.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const depositHash = `0x${"11".repeat(32)}`;
const allocateHash = `0x${"22".repeat(32)}`;
const explorer = hash => `https://explorer.example/tx/${hash}`;
const external = {
  client: `export const client=Object.fromEntries([
    'getChainId','getBlock','simulateContract','estimateContractGas','getBalance','getGasPrice',
    'waitForTransactionReceipt','getTransactionReceipt','getTransaction'
  ].map(name=>[name,(...args)=>window.fundingScenario.client[name](...args)]));`,
  wagmi: `export const useConfig=()=>window.fundingScenario.config;`,
  actions: `export const getConnection=()=>({connector:{uid:'funding-fixture'}});
    export const writeContract=(_config,request)=>window.fundingScenario.send(request);`,
  chain: `export const chain={id:10143};export const explorerTx=hash=>'https://explorer.example/tx/'+hash;`,
  deployment: `export const markets=[{engine:'0x4444444444444444444444444444444444444444'}];`,
  verification: `export const ensureDeployment=async()=>{};`,
  privy: `export const privyRequest=async()=>{throw new Error('Unexpected delegated request')};`,
  link: `import React from 'react';export default function Link(props){return React.createElement('a',props)}`,
};
const aliases = new Map([
  ["./reads", "client"], ["wagmi", "wagmi"], ["wagmi/actions", "actions"],
  ["@/config/chain", "chain"], ["@/config/deployment", "deployment"],
  ["./deployment-check", "verification"], ["./privy-api", "privy"], ["next/link", "link"],
]);
let browser, bundle;
before(async () => {
  const output = await build({ entryPoints: [path.join(directory, "funding-feedback-fixture.tsx")], bundle: true,
    write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "isolated-funding-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => aliases.has(args.path) ? { path: aliases.get(args.path), namespace: "fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: external[args.path], loader: "js", resolveDir: directory }));
    } }],
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, mode) {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "No component runtime errors");
    assert.deepEqual(requests, [], "No external wallet, RPC or service requests");
  });
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("button", { name: "Run funding sequence" })).toBeVisible();
  await page.evaluate(mode => { window.fundingScenario.mode = mode; }, mode);
  await page.getByRole("button", { name: "Run funding sequence" }).click();
  await expect(page.getByTestId("sequence-finished")).toHaveText("true");
  assert.equal(await page.evaluate(() => window.fundingScenario.observers.size), 0, "Wallet subscription released");
  assert.equal(await page.evaluate(() => window.fundingScenario.invalidations), 1, "Balances refreshed after any submitted step");
  return page;
}
async function state(page) { return JSON.parse(await page.getByTestId("transaction-state").textContent()); }
async function calls(page) {
  return page.evaluate(() => {
    const s = window.fundingScenario;
    return { simulated: s.simulated, signatures: s.signatures, sent: s.sent.map(call => call.request.functionName),
      canonicalReads: s.canonicalReads, transactionReads: s.transactionReads };
  });
}
async function confirmedDeposit(page) {
  const completed = page.getByRole("list", { name: "Completed transaction steps" });
  await expect(completed.getByRole("link", { name: "Confirmed: deposit collateral ↗", exact: true })).toHaveAttribute("href", explorer(depositHash));
  await expect(completed.getByRole("listitem")).toHaveCount(1);
}

test("confirmed deposit remains explicit when fund-market simulation rejects before submission", async t => {
  const page = await fixture(t, "allocate-preflight");
  await expect(page.getByRole("alert")).toContainText("Fund market was not submitted.");
  await expect(page.getByRole("alert")).toContainText("This market cannot accept collateral in its current state.");
  await confirmedDeposit(page);
  await expect(page.getByRole("link", { name: /^View .*transaction/ })).toHaveCount(0);
  assert.deepEqual(await state(page), {
    status: "error", step: "fund market", phase: "preflight",
    message: "This market cannot accept collateral in its current state. Accounting maintenance may be required. Refresh the market status before retrying.",
    completed: [{ hash: depositHash, label: "deposit collateral" }],
  });
  assert.deepEqual(await calls(page), { simulated: ["deposit", "allocate"], signatures: ["deposit"], sent: ["deposit"],
    canonicalReads: [depositHash], transactionReads: [depositHash] });
});

test("a submitted allocation revert links its own hash alongside the confirmed deposit", async t => {
  const page = await fixture(t, "allocate-receipt");
  await expect(page.getByRole("alert")).toContainText("Fund market could not complete.");
  await expect(page.getByRole("alert")).toContainText("Transaction reverted in block 100.");
  await confirmedDeposit(page);
  await expect(page.getByRole("link", { name: "View fund market transaction ↗", exact: true })).toHaveAttribute("href", explorer(allocateHash));
  const result = await state(page);
  assert.equal(result.hash, allocateHash);
  assert.equal(result.phase, "confirmation");
  assert.deepEqual(result.completed, [{ hash: depositHash, label: "deposit collateral" }]);
  assert.deepEqual((await calls(page)).canonicalReads, [depositHash, allocateHash]);
  assert.deepEqual((await calls(page)).transactionReads, [depositHash, allocateHash]);
});

test("wallet rejection of allocation cannot reuse the deposit hash as the failed transaction", async t => {
  const page = await fixture(t, "signature-rejected");
  await expect(page.getByRole("alert")).toContainText("User rejected wallet request.");
  await confirmedDeposit(page);
  await expect(page.getByRole("link", { name: /^View .*transaction/ })).toHaveCount(0);
  const result = await state(page);
  assert.equal(result.phase, "signature");
  assert.equal(Object.hasOwn(result, "hash"), false);
  assert.deepEqual((await calls(page)).signatures, ["deposit", "allocate"]);
  assert.deepEqual((await calls(page)).sent, ["deposit"]);
});

test("all successful funding steps finish with the allocation confirmation", async t => {
  const page = await fixture(t, "success");
  await expect(page.getByRole("status")).toContainText("fund market confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Completed transaction steps" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View transaction ↗", exact: true })).toHaveAttribute("href", explorer(allocateHash));
  await expect(page.getByRole("link", { name: "View confirmation →", exact: true })).toHaveAttribute("href", `/thank-you?tx=${allocateHash}`);
  assert.deepEqual(await state(page), { status: "done", hash: allocateHash, summary: "fund market confirmed", tone: "neutral" });
  assert.deepEqual(await calls(page), { simulated: ["deposit", "allocate"], signatures: ["deposit", "allocate"],
    sent: ["deposit", "allocate"], canonicalReads: [depositHash, allocateHash], transactionReads: [depositHash, allocateHash] });
});

test("a wallet change after deposit finality stops allocation and hides the old wallet's feedback", async t => {
  const page = await fixture(t, "wallet-change");
  assert.deepEqual(await calls(page), { simulated: ["deposit"], signatures: ["deposit"], sent: ["deposit"],
    canonicalReads: [depositHash], transactionReads: [depositHash] });
  assert.deepEqual(await state(page), { status: "idle" });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link")).toHaveCount(0);
});
