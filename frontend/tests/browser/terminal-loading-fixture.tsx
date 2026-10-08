// Real Terminal and read hooks. RPC responses and child display/action panels are isolated probes.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Terminal } from "../../src/components/terminal";
import type { MarketManifest } from "../../src/config/deployment";

const engine = "0x1111111111111111111111111111111111111111";
const firstOwner = "0x2222222222222222222222222222222222222222";
const secondOwner = "0x5555555555555555555555555555555555555555";
const hash = `0x${"ab".repeat(32)}` as const;
const Q = 10n ** 18n;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const headGate = gate();
const ownerGates = new Map([[firstOwner, gate()], [secondOwner, gate()]]);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const scenario = {
  head: 100n,
  owner: { address: firstOwner, connected: true, wrongChain: false },
  marketFailure: false,
  ownerFailures: new Set<string>(),
  calls: [] as { kind: string; block: string; owner?: string }[],
  async getBlock({ blockNumber }: { blockNumber?: bigint } = {}): Promise<{ number: bigint; hash: string; timestamp: bigint }> {
    if (blockNumber === undefined) await headGate.promise;
    return { number: blockNumber ?? scenario.head, hash, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  },
  async multicall({ contracts, blockNumber }: { contracts: { functionName: string; args?: readonly unknown[] }[]; blockNumber: bigint }): Promise<unknown[]> {
    const kind = contracts[0].functionName;
    const owner = kind === "participantId" ? String(contracts[0].args?.[0]).toLowerCase() : undefined;
    scenario.calls.push({ kind, block: String(blockNumber), owner });
    switch (kind) {
      case "active": {
        if (scenario.marketFailure) throw new Error("Public market RPC unavailable.");
        return [true, false, true, { indexAvailable: true, indexWad: Q / 2n, markAvailable: true, markWad: Q / 2n },
          {}, {}, [400, 410], [400, 1n, 410, 1n], {}, 0n, 1n, [1n, 0n, 3600n, 0n, 0n, 0n, false],
          [0n, 0n, 0n], true, {}, [0n, 0n], 0n, [0n, 0n], [0n, 0n], 10, [0n, 0n, false], [5n, 5n]];
      }
      case "participantId": {
        if (scenario.ownerFailures.has(owner!)) throw new Error("Owner balance RPC unavailable.");
        await ownerGates.get(owner!)?.promise;
        return [owner === firstOwner ? 1 : 2, 10_000_000n, 20_000_000n, 30_000_000n];
      }
      case "previewAccount": return [{ positionLots: 5000n, cashQ: 100_000_000n * Q }, {}, 0n, false];
      case "getLevel": return contracts.map(() => ({ size: 1000n }));
      default: throw new Error(`Unexpected RPC ${kind}`);
    }
  },
  releaseHead(): void { headGate.release(); },
  releaseOwner(owner?: string): void { ownerGates.get(owner ?? scenario.owner.address)?.release(); },
  switchOwner(): void { scenario.owner = { ...scenario.owner, address: secondOwner }; render(); },
  async advancePublic(): Promise<void> {
    scenario.head++;
    await queryClient.refetchQueries({ queryKey: ["head"], exact: true });
    render();
    await queryClient.refetchQueries({ queryKey: ["market", engine], exact: true });
  },
  async refreshOwner(): Promise<void> {
    await queryClient.refetchQueries({ queryKey: ["trading-snapshot", engine, scenario.owner.address], exact: true });
  },
  async failOwnerRefresh(): Promise<void> {
    scenario.ownerFailures.add(scenario.owner.address);
    await queryClient.refetchQueries({ queryKey: ["trading-snapshot", engine, scenario.owner.address], exact: true });
  },
  async failPublicRefresh(): Promise<void> {
    scenario.marketFailure = true;
    await queryClient.refetchQueries({ queryKey: ["market", engine], exact: true });
  },
  queryKeys(): (readonly unknown[])[] { return queryClient.getQueryCache().getAll().map(query => query.queryKey); },
};
declare global { interface Window { terminalLoadingScenario: typeof scenario } }
window.terminalLoadingScenario = scenario;
const manifest: MarketManifest = { engine, marketId: hash, listingHash: hash, deployBlock: 1n,
  title: "Loading regression market", short: "Loading regression", oracleMarketId: null,
  archived: false, resolution: "MANUAL_TEST_AUTHORITY", fixture: true, role: "terminal-test" };
const root = createRoot(document.getElementById("root")!);
function render() {
  flushSync(() => root.render(<QueryClientProvider client={queryClient}><Terminal manifest={manifest} /></QueryClientProvider>));
}
render();
