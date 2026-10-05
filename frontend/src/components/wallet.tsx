"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useConnect, useConnection, useDisconnect, useSwitchChain } from "wagmi";
import { Wallet, LogOut, TriangleAlert } from "lucide-react";
import { PRIVY_ENABLED } from "./providers";
import { Button } from "./ui";
import { useWalletPicker } from "./wallet-picker";
import { chain } from "@/config/chain";
import { shortAddr } from "@/lib/units";

/** The connected trading account (frontend.md R6): always the user's own wallet address. */
export function useOwner() {
  const c = useConnection();
  return { address: c.address, chainId: c.chainId, connected: c.isConnected, wrongChain: c.isConnected && c.chainId !== chain.id };
}

function WrongChain() {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <Button variant="secondary" size="sm" disabled={isPending} onClick={() => switchChain({ chainId: chain.id })}>
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
      Switch to Monad testnet
    </Button>
  );
}

function AccountPill({ address, onExit }: { address: string; onExit: () => void }) {
  return (
    <div className="flex h-8 items-stretch shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
      <span className="flex items-center gap-2 px-3 text-sm tnum">
        <span className="h-2 w-2 bg-fg" aria-hidden />
        {shortAddr(address)}
      </span>
      <button
        onClick={onExit}
        className="flex w-8 items-center justify-center text-fg-3 shadow-[inset_1px_0_0_var(--color-line-strong)] hover:bg-hover hover:text-fg"
        aria-label="Disconnect"
        title="Disconnect"
      >
        <LogOut size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function PrivyWallet() {
  const { ready, authenticated, login, logout } = usePrivy();
  const owner = useOwner();
  if (!ready) return <Button size="sm" disabled>Loading wallet…</Button>;
  if (!authenticated || !owner.address)
    return (
      <Button variant="primary" size="sm" onClick={login}>
        <Wallet size={14} strokeWidth={1.75} aria-hidden />
        Log in
      </Button>
    );
  if (owner.wrongChain) return <WrongChain />;
  return <AccountPill address={owner.address} onExit={logout} />;
}

function InjectedWallet() {
  const owner = useOwner();
  const picker = useWalletPicker();
  const { isPending } = useConnect();
  const { disconnect } = useDisconnect();
  if (!owner.connected || !owner.address)
    return (
      <Button variant="primary" size="sm" disabled={isPending} onClick={picker.open} aria-haspopup="dialog">
        <Wallet size={14} strokeWidth={1.75} aria-hidden />
        {isPending ? "Connecting…" : "Connect wallet"}
      </Button>
    );
  if (owner.wrongChain) return <WrongChain />;
  return <AccountPill address={owner.address} onExit={() => disconnect()} />;
}

function usePrivyLoginAction() {
  const { ready, login } = usePrivy();
  return { ready, login };
}
function useInjectedLoginAction() {
  const picker = useWalletPicker();
  const { isPending } = useConnect();
  return { ready: !isPending, login: picker.open };
}
/** The same login the top bar offers, usable from any call to action. */
export const useLoginAction = PRIVY_ENABLED ? usePrivyLoginAction : useInjectedLoginAction;

export function WalletButton() {
  return PRIVY_ENABLED ? <PrivyWallet /> : <InjectedWallet />;
}
