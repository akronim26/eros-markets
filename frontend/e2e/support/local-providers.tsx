"use client";
/** Test build replacement, never selected by the public build. No key lives in the browser. */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, createStorage, http, WagmiProvider, useConfig, useConnection, useConnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { getConnection, disconnect } from "wagmi/actions";
import type { EIP1193Provider } from "viem";
import { WalletSessionContext } from "@/components/wallet-session";
import { chain, RPC_URL } from "./local-chain";
export const PRIVY_ENABLED = false;
const config = createConfig({ chains: [chain], ssr: true, storage: createStorage({ key: "eros-e2e" }),
  connectors: [injected({ target: { id: "eros-local-e2e", name: "Local E2E wallet", provider: () => typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: EIP1193Provider }).ethereum } })],
  multiInjectedProviderDiscovery: false, transports: { [chain.id]: http(RPC_URL) } });
function Session({ children }: { children: ReactNode }) {
  const config = useConfig(), c = useConnection(), { connectAsync } = useConnect();
  const version = useRef(0), [error, setError] = useState<string | null>(null);
  const getSnapshot = useCallback(() => { const current = getConnection(config); return { address: current.address, chainId: current.chainId,
    connectorUid: current.connector?.uid, ready: current.isConnected, version: version.current }; }, [config]);
  async function open() { try { if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") throw new Error("Local test host required"); await connectAsync({ connector: config.connectors[0], chainId: 31337 }); } catch (e) { setError((e as Error).message); } }
  return <WalletSessionContext.Provider value={{ embedded: false, configured: true, ready: true, authenticated: c.isConnected, busy: false,
    address: c.address, error, getSnapshot, open: () => { void open(); }, logout: async () => { version.current++; await disconnect(config); } }}>
    <div role="status" className="bg-signal px-4 py-2 text-sm text-on-signal">LOCAL E2E FIXTURE · Chain 31337 · Disposable wallets · Synthetic data</div>
    {children}
  </WalletSessionContext.Provider>;
}
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 3500, refetchOnWindowFocus: false } } }));
  return <QueryClientProvider client={client}><WagmiProvider config={config} reconnectOnMount={false}><Session>{children}</Session></WagmiProvider></QueryClientProvider>;
}
