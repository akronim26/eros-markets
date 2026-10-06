"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { chain, PRIVY_APP_ID, RPC_URL } from "@/config/chain";
import { WalletPickerProvider } from "./wallet-picker";
import { useTheme } from "./theme-provider";

const config = createConfig({ chains: [chain], transports: { [chain.id]: http(RPC_URL) } });

/** Loaded only after browser storage has been checked; the SDK reads it at import time. */
export function PrivyWalletProvider({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
  const { resolved } = useTheme();
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        legal: { termsAndConditionsUrl: "/terms", privacyPolicyUrl: "/privacy" },
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
        <WagmiProvider config={config}>
          <WalletPickerProvider>{children}</WalletPickerProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
