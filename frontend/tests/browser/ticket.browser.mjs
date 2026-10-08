// From frontend/: node --test tests/browser/ticket.browser.mjs (requires installed Playwright Chromium).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const external = {
  client: `export const client={async readContract(request){
    const s=window.scenario;s.calls.push(request);
    if(request.functionName==='participantId')return s.trader.traderId;
    if(request.functionName==='account'){
      const snapshot=s.versions[String(request.blockNumber)];
      return {value:{lots:snapshot.lots},positionVersion:snapshot.version};
    }
    if(request.functionName!=='previewOrder')throw new Error('Unexpected RPC '+request.functionName);
    const lots=request.args[3];
    if(s.holdMax&&lots>s.capacity)await new Promise(resolve=>s.gates.push(resolve));
    let cap=lots;while(cap>s.capacity)cap/=2n;
    if(request.args[4]){const p=s.trader.account.preview.positionLots,opposite=(p>0n)!==(request.args[1]===0);
      const abs=p<0n?-p:p;cap=opposite&&p!==0n?(cap<abs?cap:abs):0n;}
    return {id:s.trader.account.preview.id,rejection:cap>0n?0:1,acceptedCapLots:cap,feeCapQ:100000n*10n**18n,
      requiredImQ:0n,eMinQ:0n,d0AfterQ:0n,d1AfterQ:0n,marketCoverageAfter:true};
  }};`,
  pinned: `export async function readPinned(block,read){return {block,value:await read(),timestamp:BigInt(Math.floor(Date.now()/1000))}};
    export function pinnedReadCurrent(data,block){return !!data&&data.block<=block};`,
  wallet: `export const useOwner=()=>window.scenario.owner;export const useLoginAction=()=>({ready:true,login(){throw new Error('Unexpected login')}});`,
  permissions: `export const usePermissions=()=>({data:{modes:[]}});`,
  wagmi: `export const useSwitchChain=()=>({switchChain(){throw new Error('Unexpected chain switch')}});`,
  chain: `export const chain={id:10143};export const explorerTx=()=>'';`,
  deployment: `export const marketByEngine=()=>({archived:false});`,
  tx: `export const summarizeOrder=()=>'';export const useTx=()=>({state:{status:'idle'},async run(owner,calls){
    for(const call of calls)await call.validate(window.scenario.market.block);window.scenario.submitted.push({owner,...calls[0].order});
  }});`,
  trader: `export const ownerTrader=()=>({placeOrder:order=>({order})});`,
  feedback: `export const TxFeedback=()=>null;`,
  history: `export const useHistory=()=>({data:window.scenario.history});`,
  canonical: `export const canonicalRead=async(_block,read)=>read();`,
};
const aliases = new Map([
  ["@/lib/reads", "client"], ["./reads", "client"], ["./public-client", "client"],
  ["./pinned-read", "pinned"], ["./wallet", "wallet"], ["@/lib/privy-api", "permissions"],
  ["wagmi", "wagmi"], ["@/config/chain", "chain"], ["@/config/deployment", "deployment"],
  ["@/lib/tx", "tx"], ["@/lib/trader", "trader"], ["./tx-feedback", "feedback"],
  ["@/lib/history-reads", "history"],
  ["./deployment-check", "canonical"],
]);
let browser, bundle;
before(async () => {
  const output = await build({ entryPoints: [path.join(directory, "ticket-fixture.tsx")], bundle: true,
    write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "isolated-external-services", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => aliases.has(args.path) ? { path: aliases.get(args.path), namespace: "fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: external[args.path], loader: "js" }));
    } }],
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], "No component runtime errors"); });
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("group", { name: "Trade direction and outcome" })).toBeVisible();
  return page;
}
const choose = (page, label) => page.getByRole("group", { name: "Trade direction and outcome" }).getByRole("button", { name: label, exact: true }).click();
const price = page => page.locator('input[inputmode="decimal"]').nth(0);
const size = page => page.locator('input[inputmode="decimal"]').nth(1);
const summary = page => page.locator('[aria-label="Order effect and estimate"]');
const row = (page, name) => summary(page).locator("dl > div").filter({ has: page.locator("dt", { hasText: name }) }).locator("dd");
const disclosure = (page, label) => page.locator("details").filter({ has: page.locator("summary", { hasText: label }) });
async function update(page, fn) { await page.evaluate(fn); await page.evaluate(() => window.rerender()); }
async function release(page) { await page.evaluate(() => window.releaseMax()); }

test("all four UI choices stay visible with details collapsed and submit canonical YES orders", async t => {
  const page = await fixture(t);
  const choices = [["Long YES", true, 300], ["Short YES", false, 300], ["Long NO", false, 700], ["Short NO", true, 700]];
  await expect(disclosure(page, "Trading details")).toHaveJSProperty("open", false);
  await expect(page.getByText("Long YES = Short NO.", { exact: false })).not.toBeVisible();
  for (const [label] of choices) {
    await expect(page.getByRole("group", { name: "Trade direction and outcome" }).getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  for (const [label, isBuy, tick] of choices) {
    await choose(page, label); await price(page).fill("0.300"); await size(page).fill("1");
    const submit = page.getByRole("button", { name: label, exact: true }).and(page.locator("button:not([aria-pressed])"));
    await expect(submit).toBeEnabled();
    await expect(disclosure(page, "Estimate details")).toHaveJSProperty("open", false);
    await expect(row(page, "Position before")).not.toBeVisible();
    await expect(row(page, "Effect if filled")).toBeVisible();
    await expect(row(page, "Full-backing amount")).toBeVisible();
    await expect(row(page, "Fee cap reserved")).toBeVisible();
    await submit.click();
    await expect.poll(() => page.evaluate(() => window.scenario.submitted.length)).toBe(choices.findIndex(c => c[0] === label) + 1);
    const submitted = await page.evaluate(() => { const last = window.scenario.submitted.at(-1); return { ...last, size: String(last.size) }; });
    assert.equal(submitted.isBuy, isBuy); assert.equal(submitted.tick, tick); assert.equal(submitted.size, "1000");
    assert.equal(submitted.reduceOnly, false);
  }
});

test("outcome switches preserve the YES limit, and NO best-price/book clicks are complemented once", async t => {
  const page = await fixture(t);
  await price(page).fill("0.300"); await choose(page, "Long NO");
  await expect(price(page)).toHaveValue("0.700");
  await page.getByRole("button", { name: "Use best ask", exact: true }).click();
  await expect(price(page)).toHaveValue("0.600");
  await choose(page, "Short NO"); await page.getByRole("button", { name: "Use best bid", exact: true }).click();
  await expect(price(page)).toHaveValue("0.400");
  await update(page, () => { window.scenario.bookPrice = { tick: 470, nonce: 1 }; });
  await expect(price(page)).toHaveValue("0.530");
  await choose(page, "Long YES"); await expect(price(page)).toHaveValue("0.470");
});

test("partial and full closes show cash estimates, reserve opening payoff rows for openings", async t => {
  const page = await fixture(t);
  await price(page).fill("0.600"); await size(page).fill("2");
  await expect(row(page, "Effect if filled")).toHaveText("Opens position");
  await expect(row(page, "Full-backing amount")).toBeVisible();
  await expect(row(page, "Gross payoff if YES")).not.toBeVisible();
  await disclosure(page, "Estimate details").locator("summary").click();
  await expect(row(page, "Gross payoff if YES")).toBeVisible();
  await expect(row(page, "Gross payoff if YES")).toHaveText("2.000000 USDC");
  await disclosure(page, "Estimate details").locator("summary").click();
  await update(page, () => { window.scenario.trader.account.preview.positionLots = 5000n; });
  await choose(page, "Short YES");
  await expect(row(page, "Effect if filled")).toHaveText("Reduces position");
  await expect(row(page, "Position after")).toHaveText("Long YES · 3.000 claims");
  await expect(summary(page).getByText("Full-backing amount", { exact: true })).toHaveCount(0);
  await expect(summary(page).getByText(/^Gross payoff if/)).toHaveCount(0);
  await expect(row(page, "Market cash after fill (est.)")).toBeVisible();
  await expect(row(page, "Market cash after fill (est.)")).toHaveText("81.100000 USDC");
  await expect(row(page, "Realized price P&L (est.)")).toBeVisible();
  await expect(row(page, "Realized price P&L (est.)")).toHaveText("Entry basis unavailable");
  await disclosure(page, "Estimate details").locator("summary").click();
  await expect(row(page, "USDC available to release")).toBeVisible();
  await expect(row(page, "USDC available to release")).toHaveText("Requires a fresh release preview");
  await disclosure(page, "Estimate details").locator("summary").click();
  await size(page).fill("5");
  await expect(row(page, "Effect if filled")).toHaveText("Closes position");
  await expect(row(page, "Position after")).toHaveText("Flat · 0.000 claims");
  await expect(row(page, "Market cash after fill (est.)")).toBeVisible();
  await expect(row(page, "Market cash after fill (est.)")).toHaveText("82.900000 USDC");
  await disclosure(page, "Estimate details").locator("summary").click();
  await expect(row(page, "Potential release after close")).toBeVisible();
  await expect(row(page, "Potential release after close")).toHaveText("82.900000 USDC");
  await expect(row(page, "Vault USDC after release (est.)")).toBeVisible();
  await expect(row(page, "Vault USDC after release (est.)")).toHaveText("92.900000 USDC");
});

test("a reversal is explicit and reduce-only clips the preview without claiming a new position", async t => {
  const page = await fixture(t);
  await update(page, () => { window.scenario.trader.account.preview.positionLots = 2000n; });
  await choose(page, "Long NO"); await price(page).fill("0.400"); await size(page).fill("3");
  await expect(row(page, "Effect if filled")).toHaveText("Closes and reverses position");
  await expect(row(page, "Position after")).toHaveText("Short YES · 1.000 claims");
  await expect(summary(page).getByText(/^Gross payoff if/)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Reduce only", exact: true }).check();
  await expect(row(page, "Effect if filled")).toHaveText("Closes position");
  await expect(row(page, "Position after")).toHaveText("Flat · 0.000 claims");
  await expect(row(page, "Reduce-only quantity")).toHaveText("2.000 claims");
  await expect(page.getByRole("button", { name: "Reduce size to the admissible limit" })).toBeDisabled();
});

test("Max searches listing capacity independently of a tiny or larger entered size", async t => {
  const page = await fixture(t);
  await price(page).fill("0.400"); await size(page).fill("0.001");
  await page.getByRole("button", { name: "Max", exact: true }).click();
  await expect(size(page)).toHaveValue("10.000");
  await expect(page.getByRole("status")).toContainText("Largest verified size at block 100");
  assert.ok(await page.evaluate(() => window.scenario.calls.some(call => call.args?.[3] === 100000n)));
  await size(page).fill("4"); await page.getByRole("button", { name: "Max", exact: true }).click();
  await expect(size(page)).toHaveValue("10.000");
});

test("late Max responses cannot apply after owner, side, price or reservation changes", async t => {
  for (const change of ["owner", "side", "price", "orders"]) {
    const page = await fixture(t);
    await price(page).fill("0.400"); await size(page).fill("1");
    await update(page, () => { window.scenario.holdMax = true; });
    await page.getByRole("button", { name: "Max", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.scenario.gates.length)).toBe(1);
    if (change === "owner") await update(page, () => { window.scenario.owner = { ...window.scenario.owner, address: "0x3333333333333333333333333333333333333333" }; });
    if (change === "side") await choose(page, "Short YES");
    if (change === "price") await price(page).fill("0.500");
    if (change === "orders") await update(page, () => { window.scenario.trader.account.preview.orders.askLots = 1n; });
    await release(page);
    await expect(page.getByRole("button", { name: "Max", exact: true })).toBeEnabled();
    await expect(size(page)).toHaveValue("1");
    assert.equal(await page.getByText(/Largest verified size/).count(), 0);
  }
});

test("editing size during Max cancels its ability to overwrite the newer input", async t => {
  const page = await fixture(t);
  await price(page).fill("0.400"); await size(page).fill("1");
  await update(page, () => { window.scenario.holdMax = true; });
  await page.getByRole("button", { name: "Max", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scenario.gates.length)).toBe(1);
  await size(page).fill("2"); await release(page);
  await expect(page.getByRole("button", { name: "Max", exact: true })).toBeEnabled();
  await expect(size(page)).toHaveValue("2");
  assert.equal(await page.getByText(/Largest verified size/).count(), 0);
});

test("entry-basis hook bridges unchanged versions but refuses an unseen position round trip", async t => {
  const page = await fixture(t);
  await update(page, () => {
    const s = window.scenario;
    s.trader.account.preview.positionLots = 5000n;
    s.versions = { 90: { lots: 5000n, version: 1n }, 100: { lots: 5000n, version: 1n }, 101: { lots: 5000n, version: 3n } };
    const event = (id, kind, payload, block) => ({ id, kind, engine: "0x1111111111111111111111111111111111111111",
      block, logIndex: 0, timestamp: "1000", txHash: `0x${"12".repeat(32)}`, payload: JSON.stringify(payload) });
    s.history = { progress: 90, complete: true, directionsComplete: true, prices: [],
      events: [event("fill", "Fill", { makerOrder: 1, maker: 7, taker: 8, tick: 400, size: "5000", makerFeeQ: "0", takerFeeQ: "0" }, 90)],
      makerOrders: [event("placement", "OrderPlaced", { id: 1, trader: 7, tick: 400, size: "5000", flags: 0 }, 80)] };
  });
  await choose(page, "Short YES"); await price(page).fill("0.600"); await size(page).fill("5");
  await expect(row(page, "Realized price P&L (est.)")).toHaveText("0.900000 USDC");
  assert.deepEqual(await page.evaluate(() => window.scenario.calls.filter(c => c.functionName === "account").map(c => String(c.blockNumber)).sort()), ["100", "90"]);
  await update(page, () => { window.scenario.market.block = 101n; window.scenario.trader.block = 101n; });
  await expect(row(page, "Realized price P&L (est.)")).toHaveText("Entry basis unavailable");
  await expect(row(page, "Realized price P&L (est.)")).toBeVisible();
  await expect(row(page, "Market cash after fill (est.)")).toBeVisible();
  await expect(row(page, "Market cash after fill (est.)")).toHaveText("82.900000 USDC");
  await disclosure(page, "Estimate details").locator("summary").click();
  await expect(summary(page).getByText("Position changed after the loaded fill history", { exact: false })).toBeVisible();
});
