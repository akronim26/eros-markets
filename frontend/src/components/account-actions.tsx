"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { ownerTrader } from "@/lib/trader";
import { deployment, marketByEngine } from "@/config/deployment";
import { type MarketSnapshot, type TraderSnapshot } from "@/lib/reads";
import { amountWithinBalance, atomsToInput, canClaim, fundingPlan } from "@/lib/funds";
import { atomsToUsdc, parseUsdcToAtoms } from "@/lib/units";
import { REJECT } from "@/lib/enums";
import { releasePreviewOptions } from "@/lib/collateral-queries";
import { pinnedReadCurrent } from "@/lib/pinned-read";
import { useTx } from "@/lib/tx";
import { useOwner } from "./wallet";
import { Button, cx } from "./ui";
import { FieldError, useFieldErrors, ReadError } from "./feedback";
import { TxFeedback } from "./tx-feedback";

const faucetAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
const MODES = ["Fund", "Release", "Withdraw"] as const;
export function AccountActions({ engine, m, t, readUnavailable = false }: { engine: Address; m?: MarketSnapshot; t?: TraderSnapshot; readUnavailable?: boolean }) {
  const owner = useOwner();
  const tx = useTx();
  const archived = marketByEngine(engine)?.archived ?? false;
  const fundDisabled = archived && !t?.account?.preview.positionLots;
  const [mode, setMode] = useState<(typeof MODES)[number]>(archived ? "Release" : "Fund");
  const [input, setInput] = useState("");
  let amount = 0n, error = "";
  const available = !t ? 0n : mode === "Fund" ? t.wallet + t.free : mode === "Withdraw" ? t.free : t.account?.preview.usableReleaseAtoms ?? 0n;
  try { if (input) { amount = parseUsdcToAtoms(input); if (!amount) throw new Error("Enter an amount greater than zero."); if (t) amount = amountWithinBalance(amount, available); } } catch (e) { error = (e as Error).message; }
  const validation = useFieldErrors({ amount: error || (!input ? "Enter an amount greater than zero." : "") });
  const readsReady = !!t && !!m && t.block === m.block && !readUnavailable;
  const release = useQuery({
    ...releasePreviewOptions(engine, owner.address, t?.traderId ?? 0, amount, m?.block ?? 0n),
    enabled: mode === "Release" && amount > 0n && !error && !!t?.traderId && readsReady,
  });
  const releasePreview = readsReady && pinnedReadCurrent(release.data, m?.block) ? release.data?.value : undefined;
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const blocker = mode === "Fund" && fundDisabled ? "Archived market"
    : owner.wrongChain ? "Switch to Monad testnet" : readUnavailable ? "Live reads unavailable" : !readsReady ? "Reading balances…"
    : mode !== "Withdraw" && m?.halted ? "Market halted"
    : error || (!amount ? "Enter an amount" : mode === "Release" ? release.isError ? "Release preview unavailable" : !releasePreview ? "Checking release…" : !releasePreview[0] ? REJECT[releasePreview[1]] || "Release unavailable" : "" : "");

  async function submit() {
    if (!owner.address || !t || blocker || busy) return;
    const sdk = ownerTrader(engine, owner.address);
    if (mode === "Fund") {
      const p = fundingPlan(amount, t.free, t.wallet, t.allowance);
      const calls = [];
      if (p.approve) calls.push({ ...sdk.approve(p.approve), label: "approve collateral" });
      if (p.deposit) calls.push({ ...sdk.deposit(p.deposit), label: "deposit collateral" });
      calls.push({ ...sdk.allocate(p.allocate), label: "fund market" });
      await tx.run(owner.address, calls);
    } else await tx.run(owner.address, [{ ...(mode === "Release" ? sdk.release(amount) : sdk.withdraw(amount)), label: mode.toLowerCase() }]);
  }
  const claimable = canClaim(m?.settlement, t?.account?.claimable ?? 0n, t?.account?.claimed ?? false);
  return <div className="mt-auto flex flex-col gap-3 border-t border-line p-3">
    <div role="group" aria-label="Manage collateral" className="grid grid-cols-3 gap-px bg-line">
      {MODES.map((x) => <button key={x} disabled={busy || (x === "Fund" && fundDisabled)} aria-pressed={mode === x} className={cx("label h-9 disabled:opacity-40", x === mode ? "bg-press text-fg" : "bg-ground text-fg-3")} onClick={() => { setMode(x); setInput(""); validation.reset(); tx.reset(); }}>{x}</button>)}
    </div>
    <p className="text-xs leading-relaxed text-fg-3">{mode === "Fund" ? "Add collateral to this market. Free vault funds are used first." : mode === "Release" ? "Move excess market collateral into your free vault balance." : "Send free vault collateral back to your selected wallet."}</p>
    {mode === "Release" && m && !m.halted && !m.risk.indexAvailable && <p role="status" className="border-l-2 border-signal pl-2 text-xs leading-relaxed text-fg-2">Releasing market collateral requires a fresh index, including for a flat account. Existing free vault funds can still be withdrawn.</p>}
    <label className="flex flex-col gap-1.5">
      <span className="label text-fg-3">Amount ({t?.assets.symbol ?? deployment.risk.collateralSymbol})</span>
      <div className="flex"><input inputMode="decimal" disabled={busy} {...validation.props("amount")} value={input} onChange={(e) => setInput(e.target.value)} placeholder="0.00" className="h-10 min-w-0 flex-1 border border-line-strong bg-ground px-2 text-sm tnum" /><Button className="h-10" disabled={!t || busy} onClick={() => setInput(atomsToInput(available))}>Max</Button></div>
      <FieldError id={validation.errorId("amount")}>{validation.message("amount")}</FieldError>
    </label>
    <p className="text-xs text-fg-3">Available: {t ? atomsToUsdc(available, 6) : "—"}</p>
    <Button size="lg" variant="primary" disabled={busy || !!blocker} onClick={submit}>{busy ? "Transaction pending…" : blocker || `${mode} collateral`}</Button>
    {mode === "Fund" && t && t.wallet + t.free === 0n && <div className="grid gap-2"><Button disabled={busy || owner.wrongChain || !readsReady} onClick={() => owner.address && tx.run(owner.address, [{ address: t.assets.token, abi: faucetAbi, functionName: "mint", args: [owner.address, 1000_000000n], label: "get 1,000 test tokens" }])}>Get 1,000 test tokens</Button><p className="text-xs text-fg-3">Free test collateral with no monetary value. Test MON is needed for gas.</p></div>}
    {claimable && <Button size="lg" disabled={busy || owner.wrongChain || !readsReady} onClick={() => owner.address && tx.run(owner.address, [{ ...ownerTrader(engine, owner.address).claim(), label: "claim settlement" }])}>Claim {atomsToUsdc(t!.account!.claimable)} {t?.assets.symbol ?? deployment.risk.collateralSymbol}</Button>}
    {t?.account?.claimed && !t.account.claimable && <p className="text-xs text-fg-3">Settlement claimed.</p>}
    {mode === "Release" && release.isError && <ReadError message="Could not check the available release amount." retry={() => { void release.refetch(); }} />}
    <TxFeedback state={tx.state} />
  </div>;
}
