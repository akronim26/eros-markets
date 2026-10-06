"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, createStorage, http } from "wagmi";
import { chain, PRIVY_APP_ID, RPC_URL } from "@/config/chain";
import { WalletSessionContext, unavailableWalletSession } from "./wallet-session";

export const PRIVY_ENABLED = PRIVY_APP_ID.length > 0;
const readOnlyWagmi = createConfig({ chains: [chain], connectors: [], multiInjectedProviderDiscovery: false,
  storage: createStorage({ key: "eros-public" }), transports: { [chain.id]: http(RPC_URL) }, ssr: true });

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 3500, refetchOnWindowFocus: false } } }));
  const [WalletProvider, setWalletProvider] = useState<ComponentType<{ children: ReactNode; queryClient: QueryClient }>>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!PRIVY_ENABLED) return;
    let cancelled = false;
    try {
      const key = `eros:storage-check:${Date.now()}`;
      for (const storage of [window.localStorage, window.sessionStorage]) {
        storage.setItem(key, "1");
        storage.removeItem(key);
      }
    } catch {
      setError("Wallet login needs browser storage. Allow storage for this site and reload. Public markets remain available.");
      return;
    }
    // A static import can crash the entire page before an error boundary mounts.
    void import("./privy-wallet-provider").then(({ PrivyWalletProvider }) => {
      if (!cancelled) setWalletProvider(() => PrivyWalletProvider);
    }).catch(() => {
      if (!cancelled) setError("Wallet services could not load. Reload to retry; public markets remain available.");
    });
    return () => { cancelled = true; };
  }, []);

  return <QueryClientProvider client={queryClient}>
    {WalletProvider ? <WalletProvider queryClient={queryClient}>{children}</WalletProvider> : <WagmiProvider config={readOnlyWagmi}>
      <WalletSessionContext.Provider value={{ ...unavailableWalletSession, configured: PRIVY_ENABLED, error }}>
        {children}
      </WalletSessionContext.Provider>
    </WagmiProvider>}
  </QueryClientProvider>;
}
