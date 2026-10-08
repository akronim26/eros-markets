// Real funding hook and feedback; wallet/RPC boundaries never leave this page.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, parseAbi, type Abi, type Address, type Hash } from "viem";
import { vaultAbi } from "../../src/abi/vault";
import { TxFeedback } from "../../src/components/tx-feedback";
import { WalletSessionContext, unavailableWalletSession } from "../../src/components/wallet-session";
import { useTx } from "../../src/lib/tx";
import type { WalletSnapshot } from "../../src/lib/wallet-safety";

const owner = "0x2222222222222222222222222222222222222222";
const vault = "0x3333333333333333333333333333333333333333";
const engine = "0x4444444444444444444444444444444444444444";
const depositHash = `0x${"11".repeat(32)}` as Hash;
const allocateHash = `0x${"22".repeat(32)}` as Hash;
const blockHash = `0x${"ab".repeat(32)}` as Hash;
type Mode = "allocate-preflight" | "allocate-receipt" | "signature-rejected" | "success" | "wallet-change";
type FundingRequest = { address: Address; account: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

const scenario = {
  mode: "success" as Mode,
  wallet: { address: owner, ready: true, chainId: 10143, connectorUid: "funding-fixture", version: 1 } as WalletSnapshot,
  simulated: [] as string[],
  signatures: [] as string[],
  sent: [] as { hash: Hash; request: FundingRequest }[],
  canonicalReads: [] as Hash[],
  transactionReads: [] as Hash[],
  observers: new Set<() => void>(),
  finished: false,
  invalidations: 0,
  config: {
    subscribe(_select: unknown, listener: () => void) {
      scenario.observers.add(listener);
      return () => { scenario.observers.delete(listener); };
    },
  },
  async send(request: FundingRequest): Promise<Hash> {
    scenario.signatures.push(request.functionName);
    if (request.functionName === "allocate" && scenario.mode === "signature-rejected")
      throw new Error("User rejected wallet request.");
    const hash = request.functionName === "deposit" ? depositHash : allocateHash;
    scenario.sent.push({ hash, request });
    return hash;
  },
};

function receipt(hash: Hash) {
  if (!scenario.sent.some(sent => sent.hash === hash)) throw new Error("Receipt requested for an unsent transaction.");
  return { transactionHash: hash, blockHash, blockNumber: 100n, logs: [],
    status: hash === allocateHash && scenario.mode === "allocate-receipt" ? "reverted" : "success" };
}

const client = {
  async getChainId() { return 10143; },
  async getBlock() { return { number: 100n, hash: blockHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) }; },
  async simulateContract(request: FundingRequest) {
    scenario.simulated.push(request.functionName);
    if (request.functionName === "allocate" && scenario.mode === "allocate-preflight") {
      // The vault ABI omits the engine's bubbled error, as in the reported failure.
      throw new ContractFunctionRevertedError({ abi: vaultAbi, functionName: "allocate",
        data: encodeErrorResult({ abi: parseAbi(["error BadState()"]), errorName: "BadState" }) });
    }
    return { request };
  },
  async estimateContractGas() { return 100_000n; },
  async getBalance() { return 10n ** 18n; },
  async getGasPrice() { return 1n; },
  async waitForTransactionReceipt({ hash }: { hash: Hash }) { return receipt(hash); },
  async getTransactionReceipt({ hash }: { hash: Hash }) {
    scenario.canonicalReads.push(hash);
    return receipt(hash);
  },
  async getTransaction({ hash }: { hash: Hash }) {
    scenario.transactionReads.push(hash);
    const sent = scenario.sent.find(sent => sent.hash === hash);
    if (!sent) throw new Error("Transaction requested before submission.");
    if (hash === depositHash && scenario.mode === "wallet-change") {
      scenario.wallet = { ...scenario.wallet, address: "0x5555555555555555555555555555555555555555", version: 2 };
      for (const observer of scenario.observers) observer();
    }
    return { hash, blockHash, blockNumber: 100n, from: sent.request.account, to: sent.request.address,
      value: 0n, input: encodeFunctionData(sent.request) };
  },
};

const fundingScenario = Object.assign(scenario, { client });
declare global { interface Window { fundingScenario: typeof fundingScenario } }
window.fundingScenario = fundingScenario;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const invalidate = queryClient.invalidateQueries.bind(queryClient);
queryClient.invalidateQueries = (...args) => { scenario.invalidations++; return invalidate(...args); };

function FundingFixture() {
  const tx = useTx();
  const [finished, setFinished] = useState(false);
  return <>
    <button type="button" onClick={async () => {
      scenario.finished = false;
      setFinished(false);
      await tx.run(owner, [
        { address: vault, abi: vaultAbi, functionName: "deposit", args: [25_000_000n], label: "deposit collateral" },
        { address: vault, abi: vaultAbi, functionName: "allocate", args: [engine, 25_000_000n, false], label: "fund market" },
      ]);
      scenario.finished = true;
      setFinished(true);
    }}>Run funding sequence</button>
    <TxFeedback state={tx.state} />
    <pre data-testid="transaction-state">{JSON.stringify(tx.state)}</pre>
    <pre data-testid="sequence-finished">{String(finished)}</pre>
  </>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <WalletSessionContext.Provider value={{ ...unavailableWalletSession, configured: true, ready: true,
      authenticated: true, address: owner, getSnapshot: () => scenario.wallet }}>
      <FundingFixture />
    </WalletSessionContext.Provider>
  </QueryClientProvider>,
);
