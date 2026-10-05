"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConnect, useConnection, useConnectors, type Connector } from "wagmi";
import { Wallet, X } from "lucide-react";
import { chain } from "@/config/chain";
import { cx } from "./ui";

const PickerContext = createContext<{ open: () => void }>({ open: () => {} });

/** Opens the wallet chooser from any call to action (top bar, ticket, portfolio). */
export const useWalletPicker = () => useContext(PickerContext);

/**
 * Wallets the browser announces (EIP-6963: MetaMask, Rabby, Coinbase Wallet, …), each with its own
 * name and icon. The generic "Injected" entry only appears when nothing announced itself.
 */
function useWallets() {
  const connectors = useConnectors();
  return useMemo(() => {
    const announced = connectors.filter((c) => c.id !== "injected");
    const list = announced.length > 0 ? announced : connectors;
    const seen = new Set<string>();
    return list.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }, [connectors]);
}

function friendlyError(e: Error | null) {
  if (!e) return null;
  const m = e.message.toLowerCase();
  if (m.includes("rejected") || m.includes("denied")) return "Request rejected in the wallet. Try again when ready.";
  if (m.includes("already pending")) return "A request is already open in your wallet. Finish or close it there.";
  return "The wallet could not connect. Unlock it and try again.";
}

export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const wallets = useWallets();
  const { isConnected } = useConnection();
  const { connect, isPending, variables, error, reset } = useConnect();
  const [chosen, setChosen] = useState<string | null>(null);

  const open = useCallback(() => {
    reset();
    setChosen(null);
    ref.current?.showModal();
  }, [reset]);
  const close = () => ref.current?.close();

  // Close once a wallet is connected.
  useEffect(() => {
    if (isConnected && ref.current?.open) ref.current.close();
  }, [isConnected]);

  const pick = (c: Connector) => {
    setChosen(c.uid);
    connect({ connector: c, chainId: chain.id });
  };
  const pendingUid = isPending ? (variables?.connector as Connector | undefined)?.uid ?? chosen : null;

  return (
    <PickerContext.Provider value={{ open }}>
      {children}
      <dialog
        ref={ref}
        aria-labelledby="wallet-picker-title"
        className="m-auto w-[min(420px,calc(100vw-2rem))] border border-ink bg-ground p-0 text-fg backdrop:bg-ink/40"
        onClick={(e) => e.target === ref.current && close()}
      >
        <div className="label flex h-10 items-center justify-between pl-4 text-fg-3 shadow-[inset_0_-1px_0_var(--color-ink)]">
          <span id="wallet-picker-title">CONNECT.WALLET</span>
          <button onClick={close} className="flex h-10 w-10 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm leading-relaxed text-fg-2">
            Choose the wallet to use. Its address becomes your trading account on Eros Markets.
          </p>
          {wallets.length === 0 ? (
            <p className="frame mt-4 p-4 text-sm leading-relaxed text-fg-2">
              No browser wallet found. Install or enable one (MetaMask, Rabby, Coinbase Wallet and others), then reload this page.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col">
              {wallets.map((c, i) => {
                const busy = pendingUid === c.uid;
                return (
                  <li key={c.uid}>
                    <button
                      onClick={() => pick(c)}
                      disabled={isPending}
                      className={cx(
                        "flex h-14 w-full items-center gap-3 border border-ink px-3 text-left transition-colors duration-150 hover:bg-hover disabled:cursor-not-allowed",
                        i > 0 && "-mt-px",
                        busy && "bg-hover",
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-panel">
                        {c.icon ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.icon} alt="" className="h-6 w-6" />
                        ) : (
                          <Wallet size={16} strokeWidth={1.75} aria-hidden />
                        )}
                      </span>
                      <span className="flex-1 text-sm font-medium">{c.name}</span>
                      <span className={cx("label", busy ? "text-signal-text" : "text-fg-3")}>{busy ? "Confirm in wallet…" : "Connect"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="mt-3 text-xs leading-relaxed text-signal-text" role="alert">{friendlyError(error)}</p>}
          <p className="label mt-4 text-fg-4">Network: Monad testnet (10143). You will be asked to switch if needed.</p>
        </div>
      </dialog>
    </PickerContext.Provider>
  );
}
