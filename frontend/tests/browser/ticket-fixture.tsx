// Isolated component fixture: no wallet connection, RPC, indexer or transactions leave the page.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Ticket } from "../../src/components/ticket";

const Q = 10n ** 18n;
const identity = { stage: 0, pricingMode: 1, accountingState: 0, profileHash: `0x${"ab".repeat(32)}`,
  marketOrderEpoch: 1n, indexAvailable: true, markAvailable: true, markWad: Q / 2n };
const engine = "0x1111111111111111111111111111111111111111";
const account = { positionVersion: 0n, preview: { positionLots: 0n, cashQ: 80_000_000n * Q,
  projectedFundingQ: 200_000n * Q, projectedPremiumQ: 100_000n * Q,
  orders: { bidLots: 0n, askLots: 0n, bidValueQ: 0n, askValueQ: 0n }, id: identity } };
const scenario = {
  owner: { address: "0x2222222222222222222222222222222222222222", connected: true, wrongChain: false },
  market: { block: 100n, active: true, halted: false, maxFills: 16, bestBid: 400, bestAsk: 600,
    leverageCaps: { long: 5n, short: 5n }, listing: { minOrderLots: 1n, maxOrderLots: 100_000n, deploymentCapX: 5n }, risk: identity },
  trader: { block: 100n, traderId: 8, free: 10_000_000n, account },
  bookPrice: undefined,
  holdMax: false,
  holdBasis: false,
  basisGates: [] as (() => void)[],
  capacity: 10_000n,
  calls: [] as any[], submitted: [] as any[], gates: [] as (() => void)[],
};
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root")!);
function render() {
  flushSync(() => root.render(<QueryClientProvider client={queryClient}><Ticket engine={engine} market={scenario.market as any}
    trader={scenario.trader as any} bookPrice={scenario.bookPrice} /></QueryClientProvider>));
}
Object.assign(window, { scenario, rerender: render, releaseMax() {
  scenario.holdMax = false;
  for (const release of scenario.gates.splice(0)) release();
}, releaseBasis() {
  scenario.holdBasis = false;
  for (const release of scenario.basisGates.splice(0)) release();
} });
render();
