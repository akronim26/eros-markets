"use client";
import { useState } from "react";
import { useExportWallet, usePrivy, useSigners } from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatEther, type Address } from "viem";
import { client } from "@/lib/public-client";
import { usePermissions } from "@/lib/privy-api";
import { PendingState } from "./feedback";
import { Button } from "./ui";

export function WalletTools({ address, embedded, close, reopen }: { address: Address; embedded: boolean; close: () => void; reopen: () => void }) {
  const { exportWallet } = useExportWallet(), { addSigners, removeSigners } = useSigners(), { user } = usePrivy();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [consent, setConsent] = useState<string>();
  const q = usePermissions(embedded ? address : undefined), qc = useQueryClient();
  const balance = useQuery({ queryKey: ["native-balance", address], queryFn: () => client.getBalance({ address }), refetchInterval: 15000 });
  const delegated = user?.linkedAccounts.some((a) => a.type === "wallet" && a.address.toLowerCase() === address.toLowerCase() && a.delegated);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(""); close();
    try { await fn(); await qc.invalidateQueries({ queryKey: ["permissions"] }); setConsent(undefined); }
    catch { setError("Wallet action could not be completed. No new permission is assumed; check its status and retry."); }
    finally { setBusy(false); reopen(); }
  }
  return <section className="mt-4 border-t border-line pt-4" aria-label="Wallet tools">
    <div className="flex items-center justify-between gap-3"><span className="text-xs">Gas: {balance.data !== undefined ? `${formatEther(balance.data)} MON` : balance.isPending ? "Reading…" : "unavailable"}</span><a className="text-xs text-signal-text underline" href="https://faucet.monad.xyz/" target="_blank" rel="noreferrer">Get test MON ↗</a></div>
    <p className="mt-2 break-all text-xs text-fg-3">Send testnet MON to this selected address. Mainnet MON cannot pay testnet gas.</p>
    {embedded && <>
      <Button className="mt-3 w-full" disabled={busy} onClick={() => action(() => exportWallet({ address }))}>Export Privy wallet</Button>
      <details className="mt-4"><summary className="label cursor-pointer text-fg-2">Trading permissions</summary>
        {q.isPending ? <div className="mt-3"><PendingState>Checking trading permissions…</PendingState></div> : q.isError ? <p className="mt-3 text-xs text-ask">Permission verification failed. <button className="underline" onClick={() => q.refetch()}>Retry</button></p> : !q.data?.configured ? <p className="mt-3 text-xs text-fg-3">One-click trading and background protection are awaiting server setup. Trades currently use your wallet confirmation.</p> : q.data.modes.map((p) => <div key={p.mode} className="mt-3 border border-line p-3">
          <p className="text-sm font-medium">{p.mode === "trade" ? "One-click trading" : "Background protection"}</p>
          <p className="mt-2 text-xs text-fg-3">{p.mode === "trade" ? "Place and cancel orders from this wallet." : "Place reduce-only orders and cancel orders from this wallet."} Monad testnet only. Cannot transfer tokens, withdraw, release collateral, or post oracle bonds.</p>
          <p className="mt-2 break-all text-xs text-fg-3">Signer: {p.signer}<br />Policy: {p.policy}<br />Markets: {p.engines.join(", ")}</p>
          {p.granted ? <p className="mt-2 text-xs text-bid">Granted{p.observedAt ? ` · first verified ${new Date(p.observedAt).toLocaleString()}` : ""}</p> : <>
            <label className="mt-3 flex gap-2 text-xs"><input type="checkbox" checked={consent === p.mode} onChange={(e) => setConsent(e.target.checked ? p.mode : undefined)} />Allow these actions until I revoke this signer.</label>
            <Button className="mt-2" disabled={busy || consent !== p.mode} onClick={() => action(() => addSigners({ address, signers: [{ signerId: p.signer, policyIds: [p.policy] }] }))}>Grant permission</Button>
          </>}
        </div>)}
        {delegated && <Button className="mt-3 w-full" disabled={busy} onClick={() => action(() => removeSigners({ address }))}>Revoke all additional signers</Button>}
        <p className="mt-2 text-xs text-fg-3">Revocation prevents new signatures. Transactions already broadcast can still confirm.</p>
      </details>
    </>}
    {error && <p role="alert" className="mt-3 text-xs text-ask">{error}</p>}
  </section>;
}
