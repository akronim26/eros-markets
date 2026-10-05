"use client";

import { useConnection } from "wagmi";
import { Wallet, ChevronDown, TriangleAlert } from "lucide-react";
import { Button } from "./ui";
import { useWalletSession } from "./wallet-session";
import { chain } from "@/config/chain";
import { shortAddr } from "@/lib/units";

/** Balances and writes always belong to the selected, ready Privy wallet. */
export function useOwner() {
  const c = useConnection();
  const { address } = useWalletSession();
  const connected = !!address && c.isConnected;
  return { address, chainId: c.chainId, connected, wrongChain: connected && c.chainId !== chain.id };
}

/** The same login/wallet chooser offered by the top bar. */
export function useLoginAction() {
  const { ready, open } = useWalletSession();
  return { ready, login: open };
}

export function WalletButton() {
  const session = useWalletSession();
  const owner = useOwner();
  const label = !session.configured ? "Wallet unavailable"
    : session.busy ? "Updating wallet…"
    : !session.ready ? "Loading wallet…"
    : owner.address ? shortAddr(owner.address)
    : session.authenticated ? "Choose wallet" : "Log in";

  return (
    <div className="relative">
      <Button variant={owner.address ? "secondary" : "primary"} size="sm" disabled={!session.ready}
        onClick={session.open} aria-haspopup="dialog" aria-label={owner.address ? `Manage wallet ${owner.address}` : label}>
        {owner.wrongChain ? <TriangleAlert size={14} aria-hidden /> : <Wallet size={14} aria-hidden />}
        {label}
        {owner.address && <ChevronDown size={12} aria-hidden />}
      </Button>
      {session.error && <p role="alert" className="absolute right-0 top-full z-30 mt-2 w-64 border border-line-strong bg-ground p-3 text-xs text-signal-text">{session.error}</p>}
    </div>
  );
}
