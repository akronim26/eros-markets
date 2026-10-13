// From frontend/: node --test tests/browser/terminal-loading.browser.mjs
// Tests real terminal/read-hook coordination; child probes report the props they receive.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const external = {
  rpc: `export const client={getBlock:args=>window.terminalLoadingScenario.getBlock(args),
    multicall:args=>window.terminalLoadingScenario.multicall(args)};`,
  verification: `export const ensureNetwork=async()=>{};export const ensureDeployment=async()=>{};
    export const canonicalRead=async(block,read,expectedHash)=>{
      const anchor={number:block,hash:'0x'+'ab'.repeat(32)};
      if(expectedHash&&expectedHash!==anchor.hash)throw new Error('Read block changed; retry.');
      return read(anchor);
    };`,
  assets: `export const readAssets=async()=>({vault:'0x3333333333333333333333333333333333333333',
    token:'0x4444444444444444444444444444444444444444',decimals:6,symbol:'TEST'});`,
  oracle: `export const resolveOracleBinding=()=>{throw new Error('Unexpected oracle read')};`,
  oracleRead: `export const readOracleSnapshot=()=>{throw new Error('Unexpected oracle snapshot')};`,
  live: `export const emptySeries=()=>({index:[],perp:[],trades:[]});export const readLiveSeries=()=>{throw new Error('Unexpected live series read')};`,
  history: `export const usePriceSeries=()=>({index:[],perp:[],historyStatus:'ready'});`,
  wallet: `export const useOwner=()=>window.terminalLoadingScenario.owner;`,
  css: `export default {};`,
  link: `import React from 'react';export default function Link(props){return <a {...props}/>}`,
  probes: `import React from 'react';
    export function ActionProbe({name,m,t,readUnavailable=false,needsTrader=true,requiresReduce=false,onReduce}) {
      return <section data-testid={name} data-market-block={m?.block?.toString()??''}
        data-trader-block={t?.block?.toString()??''} data-trader-id={t?.traderId??''} data-read-unavailable={String(readUnavailable)}
        data-can-reduce={String(typeof onReduce==='function')}>
        <button disabled={!m||readUnavailable||(needsTrader&&(!t||t.block!==m.block))||(requiresReduce&&!onReduce)}>{name} action</button>
      </section>;
    }`,
  ticket: `import React from 'react';import {ActionProbe} from 'fixture-probes';
    export const Ticket=({market,trader,...props})=><ActionProbe name="ticket" m={market} t={trader} {...props}/>;`,
  parts: `import React from 'react';import {ActionProbe} from 'fixture-probes';
    export const MarketHeader=({manifest,m})=><header data-testid="market-header" data-block={m?.block?.toString()??''}><h1>{manifest.title}</h1></header>;
    export const AccountPanel=props=><ActionProbe name="account" {...props}/>;
    export const PositionPanel=props=><ActionProbe name="position" requiresReduce {...props}/>;
    export const MarketInfo=({m})=><section data-testid="market-info" data-block={m?.block?.toString()??''}/>;
    export const DeadlineStrip=({m})=><section data-testid="deadlines" data-block={m?.block?.toString()??''}/>;`,
  chart: `import React from 'react';export const PriceAxis=props=><section aria-label="Price chart" data-testid="price-chart"
    data-mark={props.markUnit??''} data-read-error={String(!!props.readError)}>{props.emptyTitle}</section>;`,
  book: `import React from 'react';export const OrderBook=props=><section aria-label="Order book" data-testid="order-book"
    data-levels={props.levels.length} data-best-bid={props.bestBid}>{props.emptyReason}</section>;`,
  protection: `import React from 'react';import {ActionProbe} from 'fixture-probes';export const ProtectionPanel=props=><ActionProbe name="protection" {...props}/>;`,
  risk: `import React from 'react';import {ActionProbe} from 'fixture-probes';export const RiskPanel=props=><ActionProbe name="risk" {...props}/>;`,
  reserve: `import React from 'react';import {ActionProbe} from 'fixture-probes';export const ReservePanel=props=><ActionProbe name="reserve" {...props}/>;`,
  operations: `import React from 'react';import {ActionProbe} from 'fixture-probes';export const OperationsPanel=props=><ActionProbe name="operations" needsTrader={false} {...props}/>;`,
  orders: `import React from 'react';export const OpenOrders=({traderId,block,readUnavailable=false})=><section data-testid="open-orders"
    data-trader-id={traderId??''} data-block={block?.toString()??''} data-read-unavailable={String(readUnavailable)}>
    <button disabled={readUnavailable||!traderId}>Cancel probe order</button></section>;`,
  accountHistory: `import React from 'react';export const AccountHistory=({traderId})=><section data-testid="account-history" data-trader-id={traderId??''}/>;`,
  resolution: `import React from 'react';export const OracleMarket=()=>null;`,
};
const aliases = new Map([
  ["./public-client", "rpc"], ["./deployment-check", "verification"], ["./market-discovery", "assets"],
  ["./oracle-binding", "oracle"], ["./oracle-reads", "oracleRead"], ["./live-series", "live"],
  ["@/lib/price-history", "history"], ["./wallet", "wallet"], ["next/link", "link"],
  ["fixture-probes", "probes"], ["./ticket", "ticket"], ["./market-parts", "parts"],
  ["./price-axis", "chart"], ["./order-book", "book"], ["./protection-panel", "protection"],
  ["./risk-panel", "risk"], ["./reserve-panel", "reserve"], ["./operations-panel", "operations"],
  ["./open-orders", "orders"], ["./account-history", "accountHistory"], ["./resolution", "resolution"],
]);
let browser, bundle;
before(async () => {
  const output = await build({ entryPoints: [path.join(directory, "terminal-loading-fixture.tsx")], bundle: true,
    write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "terminal-loading-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const mock = args.path.endsWith(".module.css") ? "css" : aliases.get(args.path);
        return mock ? { path: mock, namespace: "fixture" } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: external[args.path], loader: "jsx", resolveDir: directory }));
    } }],
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t) {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "No terminal runtime errors");
    assert.deepEqual(requests, [], "No external RPC, wallet or service requests");
  });
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("main", { name: "Trading terminal" })).toBeVisible();
  return page;
}
const terminal = page => page.getByRole("main", { name: "Trading terminal" });
async function releasePublic(page) {
  await page.evaluate(() => window.terminalLoadingScenario.releaseHead());
  await expect(terminal(page)).toHaveAttribute("data-market-state", "ready");
  await expect(page.getByTestId("market-header")).toHaveAttribute("data-block", "100");
}
async function releaseOwner(page) {
  await page.evaluate(() => window.terminalLoadingScenario.releaseOwner());
  await expect(terminal(page)).toHaveAttribute("data-account-state", "ready");
}
async function paired(page, name, traderId, block = "100") {
  await expect(page.getByTestId(name)).toHaveAttribute("data-market-block", block);
  await expect(page.getByTestId(name)).toHaveAttribute("data-trader-block", block);
  await expect(page.getByTestId(name)).toHaveAttribute("data-trader-id", String(traderId));
}

test("the terminal shell appears before RPC completion and public data does not wait for wallet balances", async t => {
  const page = await fixture(t);
  await expect(terminal(page)).toHaveAttribute("data-market-state", "loading");
  await expect(terminal(page)).toHaveAttribute("data-account-state", "loading");
  await expect(page.getByRole("heading", { name: "Loading regression market" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Trade" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Price chart" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Order book" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Trading activity" })).toBeVisible();
  await releasePublic(page);
  await expect(terminal(page)).toHaveAttribute("data-account-state", "loading");
  await expect(page.getByTestId("price-chart")).toHaveAttribute("data-mark", "0.5");
  await expect(page.getByTestId("order-book")).toHaveAttribute("data-best-bid", "400");
  await expect(page.getByTestId("order-book")).not.toHaveAttribute("data-levels", "0");
  await expect(page.getByRole("button", { name: "ticket action", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "account action", exact: true })).toBeDisabled();
  await expect(page.getByTestId("ticket")).toHaveAttribute("data-market-block", "");
  assert.equal(await page.evaluate(() => window.terminalLoadingScenario.calls.filter(call => call.kind === "active").length), 1,
    "The owner snapshot shares the in-flight public market read");
  await releaseOwner(page);
  await paired(page, "ticket", 1);
  await paired(page, "account", 1);
  await expect(page.getByRole("button", { name: "ticket action", exact: true })).toBeEnabled();
  await page.evaluate(() => window.terminalLoadingScenario.advancePublic());
  await expect(page.getByTestId("market-header")).toHaveAttribute("data-block", "101");
  await paired(page, "ticket", 1); // The newer public block must never be mixed with the old account.
  await page.evaluate(() => window.terminalLoadingScenario.refreshOwner());
  await paired(page, "ticket", 1, "101"); await paired(page, "account", 1, "101");
  assert.ok(await page.evaluate(() => window.terminalLoadingScenario.calls.some(call => call.kind === "participantId" && call.block === "101")),
    "The refreshed owner snapshot is read at the newer public block");
});

test("switching wallets preserves the public terminal and clears old owner data from action panels", async t => {
  const page = await fixture(t);
  await releasePublic(page); await releaseOwner(page);
  await paired(page, "ticket", 1);
  await page.evaluate(() => window.terminalLoadingScenario.switchOwner());
  await expect(terminal(page)).toHaveAttribute("data-market-state", "ready");
  await expect(terminal(page)).toHaveAttribute("data-account-state", "loading");
  await expect(page.getByTestId("ticket")).toHaveAttribute("data-trader-id", "");
  await expect(page.getByTestId("account")).toHaveAttribute("data-trader-id", "");
  await expect(page.getByRole("button", { name: "ticket action", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "account action", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Open orders", exact: true }).click();
  await expect(page.getByTestId("open-orders")).toHaveCount(0);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.getByTestId("account-history")).toHaveCount(0);
  await page.getByRole("tab", { name: "Protection", exact: true }).click();
  await expect(page.getByTestId("protection")).toHaveCount(0);
  for (const [label, probe] of [["Risk", "risk"], ["Liquidity", "reserve"], ["Operations", "operations"]]) {
    await page.getByRole("combobox", { name: "More market details" }).selectOption(label);
    await expect(page.getByTestId(probe)).toHaveCount(0);
  }
  await page.getByRole("combobox", { name: "More market details" }).selectOption("Market info");
  await expect(page.getByTestId("market-info")).toHaveAttribute("data-block", "100");
  const publicKeys = await page.evaluate(() => window.terminalLoadingScenario.queryKeys().filter(key => key[0] === "market"));
  assert.deepEqual(publicKeys, [["market", "0x1111111111111111111111111111111111111111"]]);
  await releaseOwner(page);
  await paired(page, "ticket", 2); await paired(page, "account", 2);
  await page.getByRole("tab", { name: "Position", exact: true }).click(); await paired(page, "position", 2);
  await page.getByRole("tab", { name: "Protection", exact: true }).click(); await paired(page, "protection", 2);
  await page.getByRole("combobox", { name: "More market details" }).selectOption("Risk"); await paired(page, "risk", 2);
  await page.getByRole("combobox", { name: "More market details" }).selectOption("Liquidity"); await paired(page, "reserve", 2);
});

test("failed owner refresh leaves public market data visible and fails owner actions closed", async t => {
  const page = await fixture(t);
  await releasePublic(page); await releaseOwner(page);
  await page.evaluate(() => window.terminalLoadingScenario.failOwnerRefresh());
  await expect(terminal(page)).toHaveAttribute("data-account-state", "error");
  await expect(terminal(page)).toHaveAttribute("data-market-state", "ready");
  await expect(page.getByTestId("market-header")).toHaveAttribute("data-block", "100");
  await expect(page.getByTestId("price-chart")).toHaveAttribute("data-read-error", "false");
  await expect(page.getByTestId("order-book")).toHaveAttribute("data-best-bid", "400");
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  await expect(page.getByRole("button", { name: "ticket action", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "account action", exact: true })).toBeDisabled();
  await expect(page.getByTestId("ticket")).toHaveAttribute("data-trader-id", "");
  await page.getByRole("tab", { name: "Protection", exact: true }).click();
  await expect(page.getByRole("button", { name: "protection action", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "More market details" }).selectOption("Liquidity");
  await expect(page.getByRole("button", { name: "reserve action", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "More market details" }).selectOption("Operations");
  await expect(page.getByRole("button", { name: "operations action", exact: true })).toBeDisabled();
});

test("failed public refresh retains the last visible market snapshot without enabling actions", async t => {
  const page = await fixture(t);
  await releasePublic(page); await releaseOwner(page);
  await page.evaluate(() => window.terminalLoadingScenario.failPublicRefresh());
  await expect(terminal(page)).toHaveAttribute("data-market-state", "error");
  await expect(page.getByTestId("market-header")).toHaveAttribute("data-block", "100");
  await expect(page.getByTestId("price-chart")).toHaveAttribute("data-read-error", "true");
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  for (const name of ["ticket", "account"]) {
    await expect(page.getByTestId(name)).toHaveAttribute("data-read-unavailable", "true");
    await expect(page.getByRole("button", { name: `${name} action`, exact: true })).toBeDisabled();
  }
  await expect(page.getByTestId("position")).toHaveAttribute("data-can-reduce", "false");
  await expect(page.getByRole("button", { name: "position action", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Open orders", exact: true }).click();
  await expect(page.getByTestId("open-orders")).toHaveAttribute("data-read-unavailable", "true");
  await expect(page.getByRole("button", { name: "Cancel probe order", exact: true })).toBeDisabled();
});
