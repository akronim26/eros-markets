"use client";

import { WalletTools } from "./wallet-tools";
import type { Address } from "viem";
import type { RefObject } from "react";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { Check, LogOut, Wallet, X } from "lucide-react";
import { Button, cx } from "./ui";
import { explorerAddress } from "@/config/chain";

type Props = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  wallets: ConnectedWallet[];
  activeAddress?: string;
  hasEmbedded: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  wrongChain: boolean;
  onSelect: (wallet: ConnectedWallet) => Promise<void>;
  onCreate: () => Promise<void>;
  onConnect: () => void;
  onSwitchChain: () => Promise<void>;
  onLogout: () => Promise<void>;
};

export function WalletDialog({ dialogRef, wallets, activeAddress, hasEmbedded, busy, error, notice, wrongChain, onSelect, onCreate, onConnect, onSwitchChain, onLogout }: Props) {
  const close = () => dialogRef.current?.close();
  return (
    <dialog ref={dialogRef} aria-labelledby="wallet-picker-title" aria-describedby="wallet-picker-description"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(440px,calc(100vw-2rem))] overflow-y-auto border border-line-strong bg-ground p-0 text-fg backdrop:bg-ink/40"
      onClick={(e) => e.target === dialogRef.current && close()}>
      <div className="label flex h-10 items-center justify-between pl-4 text-fg-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]">
        <h2 id="wallet-picker-title">YOUR.WALLETS</h2>
        <button onClick={close} className="flex h-10 w-10 items-center justify-center hover:bg-hover hover:text-fg" aria-label="Close wallet chooser">
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="p-4" aria-busy={busy}>
        <p id="wallet-picker-description" className="text-sm leading-relaxed text-fg-2">
          Choose your trading wallet. Each address has its own balances and positions. Switching wallets does not move funds.
        </p>
        {wallets.length === 0 ? <p className="frame mt-4 p-3 text-sm text-fg-3">Connect an existing wallet or create a new one to start trading.</p> : (
          <ul className="mt-4 flex flex-col gap-2" aria-label="Connected wallets">
            {wallets.map((wallet) => {
              const active = wallet.address.toLowerCase() === activeAddress?.toLowerCase();
              const embedded = wallet.walletClientType === "privy" || wallet.walletClientType === "privy-v2";
              return (
                <li key={`${wallet.walletClientType}:${wallet.address}`}>
                  <button disabled={busy} onClick={() => onSelect(wallet)} aria-pressed={active}
                    className={cx("flex w-full items-start gap-3 border border-line-strong p-3 text-left hover:bg-hover disabled:cursor-not-allowed", active && "bg-hover")}>
                    <Wallet size={18} className="mt-1 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{embedded ? "Privy wallet" : wallet.meta.name}</span>
                      <span className="mt-1 block break-all text-xs text-fg-3">{wallet.address}</span>
                      <span className="label mt-2 flex items-center gap-1 text-fg-3">
                        {active && <Check size={12} aria-hidden />}{active ? "Selected for trading" : "Use this wallet"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {activeAddress && <a href={explorerAddress(activeAddress)} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs underline">View selected wallet on explorer ↗</a>}
        {activeAddress && <WalletTools key={activeAddress} address={activeAddress as Address} embedded={wallets.some((w) => w.address.toLowerCase() === activeAddress.toLowerCase() && ["privy", "privy-v2"].includes(w.walletClientType))} close={close} reopen={() => dialogRef.current?.showModal()} />}
        {wrongChain && <div className="frame mt-4 p-3">
          <p className="mb-3 text-xs text-fg-2">Switch the selected wallet to Monad testnet to trade.</p>
          <Button size="sm" disabled={busy} onClick={onSwitchChain}>Switch to Monad testnet</Button>
        </div>}
        {notice && <p role="status" className="mt-3 text-xs leading-relaxed text-fg-2">{notice}</p>}
        {error && <p role="alert" className="mt-3 break-words text-xs leading-relaxed text-signal-text">{error}</p>}
        {busy && <p role="status" className="label mt-3 text-fg-3">Updating wallet…</p>}
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="secondary" disabled={busy} onClick={onConnect}>Connect existing wallet</Button>
          {!hasEmbedded && <Button variant="secondary" disabled={busy} onClick={onCreate}>Create Privy wallet</Button>}
          <Button variant="ghost" disabled={busy} onClick={onLogout}><LogOut size={14} aria-hidden />Log out</Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-fg-3">New wallets need testnet MON for gas and test collateral before trading.</p>
      </div>
    </dialog>
  );
}
