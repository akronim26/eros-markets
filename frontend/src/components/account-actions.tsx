"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { vaultAbi } from "@/abi/vault";
import { deployment } from "@/config/deployment";
import { client, erc20Abi, type MarketSnapshot, type TraderSnapshot } from "@/lib/reads";
import { amountWithinBalance, atomsToInput, canClaim, fundingPlan } from "@/lib/funds";
import { atomsToUsdc, parseUsdcToAtoms } from "@/lib/units";
import { REJECT } from "@/lib/enums";
import { useTx } from "@/lib/tx";
import { useOwner } from "./wallet";
import { Button, cx } from "./ui";
import { FieldError, useFieldErrors, ReadError } from "./feedback";
import { TxFeedback } from "./tx-feedback";

const MODES = ["Fund", "Release", "Withdraw"] as const;
export function AccountActions({ engine, m, t }: { engine: Address; m?: MarketSnapshot; t?: TraderSnapshot }) {
  const owner = useOwner();
  const tx = useTx();
  const [mode, setMode] = useState<(typeof MODES)[number]>("Fund");
  const [input, setInput] = useState("");
  let amount = 0n, error = "";
  const available = !t ? 0n : mode === "Fund" ? t.wallet + t.free : mode === "Withdraw" ? t.free : t.account?.preview.usableReleaseAtoms ?? 0n;
  try { if (input) { amount = parseUsdcToAtoms(input); if (!amount) throw new Error("Enter an amount greater than zero."); if (t) amount = amountWithinBalance(amount, available); } } catch (e) { error = (e as Error).message; }
  const validation = useFieldErrors({ amount: error || (!input ? "Enter an amount greater than zero." : "") });
  const release = useQuery({
    queryKey: ["release-preview", engine, owner.address, t?.traderId, amount.toString(), m?.block.toString()],
    enabled: mode === "Release" && amount > 0n && !error && !!t?.traderId && !!m,
    queryFn: () => client.readContract({ address: engine, abi: engineAbi, functionName: "previewRelease", args: [t!.traderId, amount], blockNumber: m!.block }),
  });
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const blocker = owner.wrongChain ? "Switch to Monad testnet" : !t || !m ? "Reading balances…"
    : mode !== "Withdraw" && m.halted ? "Market halted"
    : error || (!amount ? "Enter an amount" : mode === "Release" ? release.isError ? "Release preview unavailable" : !release.data ? "Checking release…" : !release.data[0] ? REJECT[release.data[1]] || "Release unavailable" : "" : "");

  async function submit() {
    if (!owner.address || !t || blocker || busy) return;
    if (mode === "Fund") {
      const p = fundingPlan(amount, t.free, t.wallet, t.allowance);
      const calls = [];
      if (p.approve) calls.push({ address: t.assets.token, abi: erc20Abi, functionName: "approve", args: [t.assets.vault, p.approve], label: "approve collateral" });
      if (p.deposit) calls.push({ address: t.assets.vault, abi: vaultAbi, functionName: "deposit", args: [p.deposit], label: "deposit collateral" });
      calls.push({ address: t.assets.vault, abi: vaultAbi, functionName: "allocate", args: [engine, p.allocate, false], label: "fund market" });
      await tx.run(owner.address, calls);
    } else await tx.run(owner.address, [{ address: mode === "Release" ? engine : t.assets.vault,
      abi: mode === "Release" ? engineAbi : vaultAbi, functionName: mode === "Release" ? "release" : "withdraw", args: [amount], label: mode.toLowerCase() }]);
  }
  const claimable = canClaim(m?.settlement, t?.account?.claimable ?? 0n, t?.account?.claimed ?? false);
  return <div className="mt-auto flex flex-col gap-3 border-t border-line p-3">
    <div role="group" aria-label="Manage collateral" className="grid grid-cols-3 gap-px bg-line">
      {MODES.map((x) => <button key={x} disabled={busy} aria-pressed={mode === x} className={cx("label h-9", x === mode ? "bg-press text-fg" : "bg-ground text-fg-3")} onClick={() => { setMode(x); setInput(""); validation.reset(); tx.reset(); }}>{x}</button>)}
    </div>
    <p className="text-xs leading-relaxed text-fg-3">{mode === "Fund" ? "Add collateral to this market. Free vault funds are used first." : mode === "Release" ? "Move excess market collateral into your free vault balance." : "Send free vault collateral back to your selected wallet."}</p>
    <label className="flex flex-col gap-1.5">
      <span className="label text-fg-3">Amount ({t?.assets.symbol ?? deployment.risk.collateralSymbol})</span>
      <div className="flex"><input inputMode="decimal" disabled={busy} {...validation.props("amount")} value={input} onChange={(e) => setInput(e.target.value)} placeholder="0.00" className="h-10 min-w-0 flex-1 border border-line-strong bg-ground px-2 text-sm tnum" /><Button className="h-10" disabled={!t || busy} onClick={() => setInput(atomsToInput(available))}>Max</Button></div>
      <FieldError id={validation.errorId("amount")}>{validation.message("amount")}</FieldError>
    </label>
    <p className="text-xs text-fg-3">Available: {t ? atomsToUsdc(available, 6) : "—"}</p>
    <Button size="lg" variant="primary" disabled={busy || !!blocker} onClick={submit}>{busy ? "Transaction pending…" : blocker || `${mode} collateral`}</Button>
    {mode === "Fund" && t && t.wallet + t.free === 0n && <p className="text-xs text-fg-3">Ask the testnet operator for test collateral. MON is also needed for gas.</p>}
    {claimable && <Button size="lg" disabled={busy || owner.wrongChain} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: "claimTrader", args: [owner.address], label: "claim settlement" }])}>Claim {atomsToUsdc(t!.account!.claimable)} {t?.assets.symbol ?? deployment.risk.collateralSymbol}</Button>}
    {t?.account?.claimed && <p className="text-xs text-fg-3">Settlement claimed.</p>}
    {mode === "Release" && release.isError && <ReadError message="Could not check the available release amount." retry={() => { void release.refetch(); }} />}
    <TxFeedback state={tx.state} />
  </div>;
}
