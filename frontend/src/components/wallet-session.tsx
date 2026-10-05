"use client";

import { createContext, useContext } from "react";
import type { Address } from "viem";
import type { WalletSnapshot } from "@/lib/wallet-safety";
export type { WalletSnapshot } from "@/lib/wallet-safety";

type WalletSession = {
  embedded: boolean;
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  busy: boolean;
  address?: Address;
  error: string | null;
  open: () => void;
  logout: () => Promise<void>;
  getSnapshot: () => WalletSnapshot;
};

// Public market reads still work when Privy has not been configured.
export const WalletSessionContext = createContext<WalletSession>({
  embedded: false,
  configured: false,
  ready: false,
  authenticated: false,
  busy: false,
  error: null,
  open: () => {},
  logout: async () => {},
  getSnapshot: () => ({ ready: false, version: 0 }),
});

export const useWalletSession = () => useContext(WalletSessionContext);
