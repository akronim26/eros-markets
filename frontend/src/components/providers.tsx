"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider as PrivyWagmiProvider, createConfig as privyCreateConfig } from "@privy-io/wagmi";
import { WagmiProvider, createConfig, http } from "wagmi";
import { chain, PRIVY_APP_ID, RPC_URL } from "@/config/chain";
import { WalletPickerProvider } from "./wallet-picker";
import { useTheme } from "./theme-provider";

export const PRIVY_ENABLED = PRIVY_APP_ID.length > 0;

const privyWagmi = privyCreateConfig({ chains: [chain], transports: { [chain.id]: http(RPC_URL) } });
const readOnlyWagmi = createConfig({ chains: [chain], connectors: [], multiInjectedProviderDiscovery: false, transports: { [chain.id]: http(RPC_URL) }, ssr: true });

export function Providers({ children }: { children: ReactNode }) {
  const { resolved } = useTheme();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false } } }));

  if (!PRIVY_ENABLED) {
    return (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={readOnlyWagmi}>
          {children}
        </WagmiProvider>
      </QueryClientProvider>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: resolved === "dark" ? "#101112" : "#F2F1EC", accentColor: "#FF5A36", logo: `/brand/eros-markets-lockup-on-${resolved}.svg`,
          landingHeader: "Log in to trade",
          loginMessage: "Connect a wallet or sign in with email or Google.",
          walletChainType: "ethereum-only",
          walletList: ["detected_ethereum_wallets", "metamask", "coinbase_wallet", "rainbow", "wallet_connect"],
        },
        // Coinbase's smart-wallet path does not support this deployment's chain.
        externalWallets: { coinbaseWallet: { config: { preference: { options: "eoaOnly" } } } },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <PrivyWagmiProvider config={privyWagmi}>
          <WalletPickerProvider>{children}</WalletPickerProvider>
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
