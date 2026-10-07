"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getEmbeddedConnectedWallet, useCreateWallet, useLinkAccount, useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useConfig, useConnection } from "wagmi";
import { disconnect, getConnection, getConnections, switchChain } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import { chain } from "@/config/chain";
import { WalletSessionContext, type WalletSnapshot } from "./wallet-session";
import { WalletDialog } from "./wallet-dialog";

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Privy owns login, wallet creation, external wallet connections and account selection. */
export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { ready: authReady, authenticated, user, logout: privyLogout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { setActiveWallet } = useSetActiveWallet();
  const config = useConfig();
  const connection = useConnection();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { login } = useLogin({ onError: (e) => {
    if (message(e) !== "exited_auth_flow") setError("Could not log in. Please try again.");
  } });
  const { linkWallet } = useLinkAccount({
    onSuccess: () => dialog.current?.showModal(),
    onError: (e) => {
      if (message(e) !== "exited_link_flow" && message(e) !== "exited_auth_flow") setError("Could not connect the wallet. Unlock it and try again.");
      dialog.current?.showModal();
    },
  });
  const ready = authReady && walletsReady && !busy;
  const identity = `${ready}:${authenticated}:${user?.id ?? ""}`;
  const live = useRef({ identity, version: 0, ready: false, wallets });
  if (live.current.identity !== identity) live.current.version++;
  live.current = { ...live.current, identity, ready: ready && authenticated, wallets };

  // Read wagmi's live store, including account changes that occur before React re-renders.
  const getSnapshot = useCallback((): WalletSnapshot => {
    const c = getConnection(config);
    const known = live.current.wallets.some((w) => w.address.toLowerCase() === c.address?.toLowerCase());
    return {
      address: c.address, chainId: c.chainId, connectorUid: c.connector?.uid,
      ready: live.current.ready && c.isConnected && known, version: live.current.version,
    };
  }, [config]);
  const snapshot = getSnapshot();

  useEffect(() => {
    if (!authenticated) dialog.current?.close();
  }, [authenticated]);

  function begin() {
    // Immediately invalidate any pending multi-transaction flow, even before a render.
    live.current.ready = false;
    live.current.version++;
    setBusy(true);
    setError(null);
    setNotice(null);
  }

  function open() {
    setError(null);
    setNotice(null);
    if (!ready) return;
    if (!authenticated) login();
    else dialog.current?.showModal();
  }

  async function select(wallet: ConnectedWallet) {
    if (busy) return;
    begin();
    try {
      await setActiveWallet(wallet);
      // The SDK initiates wagmi's mutation; its promise may resolve before connection completes.
      await new Promise<void>((resolve, reject) => {
        const matches = () => {
          const c = getConnection(config);
          return c.isConnected && c.address?.toLowerCase() === wallet.address.toLowerCase();
        };
        if (matches()) { resolve(); return; }
        const timer = setTimeout(() => { stop(); reject(new Error("Wallet selection timed out. Unlock the wallet and try again.")); }, 12000);
        const stop = config.subscribe((s) => s, () => {
          if (matches()) { clearTimeout(timer); stop(); resolve(); }
        });
      });
      dialog.current?.close();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  async function create() {
    if (busy) return;
    begin();
    dialog.current?.close(); // Allow Privy's recovery/setup dialog to receive focus.
    try {
      await createWallet();
      setNotice("Your new wallet is ready. Select it below to use it for trading.");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); dialog.current?.showModal(); }
  }

  function connect() {
    setError(null);
    dialog.current?.close();
    linkWallet({ walletChainType: "ethereum-only" });
  }

  async function changeChain() {
    if (busy) return;
    begin();
    try { await switchChain(config, { chainId: chain.id }); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  async function logout() {
    if (busy) return;
    begin();
    try {
      // Disconnect every wagmi connector so no previously selected account survives logout.
      for (const c of getConnections(config)) await disconnect(config, { connector: c.connector });
      await privyLogout();
      await qc.cancelQueries({ predicate: (q) => ["trader", "trading-snapshot", "previewOrder"].includes(String(q.queryKey[0])) });
      qc.removeQueries({ predicate: (q) => ["trader", "trading-snapshot", "previewOrder"].includes(String(q.queryKey[0])) });
      dialog.current?.close();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  return (
    <WalletSessionContext.Provider value={{ configured: true, ready, authenticated, busy, embedded: wallets.some((w) => w.address.toLowerCase() === snapshot.address?.toLowerCase() && ["privy", "privy-v2"].includes(w.walletClientType)),
      address: snapshot.ready ? snapshot.address : undefined, error, open, logout, getSnapshot }}>
      {children}
      <WalletDialog dialogRef={dialog} wallets={wallets} activeAddress={connection.address}
        hasEmbedded={!!getEmbeddedConnectedWallet(wallets) || !!user?.linkedAccounts.some((a) => a.type === "wallet" && a.chainType === "ethereum" && (a.walletClientType === "privy" || a.walletClientType === "privy-v2"))}
        busy={busy} error={error} notice={notice} wrongChain={connection.isConnected && connection.chainId !== chain.id}
        onSelect={select} onCreate={create} onConnect={connect} onSwitchChain={changeChain} onLogout={logout} />
    </WalletSessionContext.Provider>
  );
}
