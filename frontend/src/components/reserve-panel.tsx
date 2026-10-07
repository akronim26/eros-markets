"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { vaultAbi } from "@/abi/vault";
import { client, erc20Abi, type MarketSnapshot, type TraderSnapshot } from "@/lib/reads";
import { fundingPlan } from "@/lib/funds";
import { atomsToUsdc, fmtUtc, parseUsdcToAtoms, qToMoney } from "@/lib/units";
import { reserveAbi, reserveOptions } from "@/lib/collateral-queries";
import { pinnedReadCurrent } from "@/lib/pinned-read";
import { useTx } from "@/lib/tx";
import { useOwner } from "./wallet";
import { Button, Row } from "./ui";
import { FieldError, useFieldErrors, LoadingPanel } from "./feedback";
import { TxFeedback } from "./tx-feedback";

export function ReservePanel({ engine, m, t, readUnavailable = false }: { engine: Address; m: MarketSnapshot; t?: TraderSnapshot; readUnavailable?: boolean }) {
  const owner = useOwner(), tx = useTx();
  const [amount, setAmount] = useState(""), [accept, setAccept] = useState(false);
  const q = useQuery({ ...reserveOptions(engine, owner.address, m.block), enabled: !readUnavailable });
  const data = q.data?.value;
  const current = pinnedReadCurrent(q.data, m.block);
  let atoms = 0n, error = "";
  try { if (amount) { atoms = parseUsdcToAtoms(amount); if (!atoms) throw new Error("Enter an amount greater than zero."); if (t) fundingPlan(atoms, t.free, t.wallet, t.allowance); } } catch (e) { error = (e as Error).message; }
  const validation = useFieldErrors({ amount: error || (!amount ? "Enter an amount greater than zero." : "") });
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const ready = !!owner.address && !owner.wrongChain && !!data && current && !readUnavailable && !q.isError && !busy;
  async function seed() {
    if (!ready || !t || t.block !== m.block || !owner.address || !atoms || !accept || error || m.halted || m.active) return;
    const p = fundingPlan(atoms, t.free, t.wallet, t.allowance), calls = [];
    if (p.approve) calls.push({ address: t.assets.token, abi: erc20Abi, functionName: "approve", args: [t.assets.vault, p.approve], label: "approve reserve collateral" });
    if (p.deposit) calls.push({ address: t.assets.vault, abi: vaultAbi, functionName: "deposit", args: [p.deposit], label: "deposit reserve collateral" });
    calls.push({ address: t.assets.vault, abi: vaultAbi, functionName: "allocate", args: [engine, atoms, true], label: "seed reserve", validate: async (blockNumber: bigint) => {
      if (await client.readContract({ address: engine, abi: engineAbi, functionName: "active", blockNumber })) throw new Error("Market activated during funding. Your deposit remains free in the vault; share issuance is closed.");
    } });
    await tx.run(owner.address, calls); setAccept(false);
  }
  return <section className="grid gap-6 p-4 sm:grid-cols-2" aria-label="Reserve liquidity">
    <div><h3 className="text-base font-semibold">Reserve liquidity</h3><p className="mt-2 text-sm leading-relaxed text-fg-3">The reserve absorbs trader deficits and earns premium when leverage is enabled. Shares can lose value and remain locked through settlement and a seven-day withdrawal notice.</p>
      {m.active ? <p className="mt-3 text-sm text-fg-2">Share issuance is closed. Deposits after activation are donations and mint no shares.</p> : <div className="mt-4 grid gap-3">
        <label className="text-xs">Seed amount ({t?.assets.symbol ?? "collateral"})<input inputMode="decimal" disabled={busy} {...validation.props("amount")} value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-10 w-full border border-line-strong bg-ground px-3" placeholder="0.00" /><FieldError id={validation.errorId("amount")}>{validation.message("amount")}</FieldError></label>
        <label className="flex gap-2 text-xs text-fg-2"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />I accept the loss risk and withdrawal lock. If governance activates the market before my allocation confirms, it becomes a donation with no shares.</label>
        <Button variant="primary" disabled={!ready || !t || t.block !== m.block || !atoms || !!error || !accept || m.halted || (data!.holders >= 256n && !data!.user?.shares)} onClick={seed}>Seed reserve</Button>
      </div>}
      <TxFeedback state={tx.state} />
    </div>
    <div>{(readUnavailable || (!!data && !current)) && <p role="status" className="mb-3 text-sm text-fg-3">Reserve data is stale. Refreshing before wallet actions.</p>}{q.isPending ? <LoadingPanel label="Reading reserve liquidity" /> : q.isError ? <p className="text-sm text-ask">Reserve read failed. <button className="underline" onClick={() => q.refetch()}>Retry</button></p> : <dl><Row k="Reserve cash" v={qToMoney(m.reserve.cashQ).usdc} /><Row k="Shareholders" v={data ? `${data.holders} / 256` : "…"} /><Row k="Your seed shares" v={data?.user ? atomsToUsdc(data.user.shares, 6) : "—"} /><Row k="Notice matures" v={data?.user?.noticeAt ? fmtUtc(data.user.noticeAt + 604800n) : "Not started"} /><Row k="Prepared payout" v={m.settlement.claimsEnabled && data?.user ? atomsToUsdc(data.user.prepared, 6) : "Pending settlement"} /></dl>}
      {data?.user && <div className="mt-4 flex flex-wrap gap-2"><Button disabled={!ready || !data.user.shares || data.user.noticed === data.user.shares} onClick={() => owner.address && tx.run(owner.address, [{ address: data!.address, abi: reserveAbi, functionName: "notice", args: [], label: "start seven-day notice" }])}>Start withdrawal notice</Button><Button disabled={!ready || !data.user.redeem || !m.settlement.claimsEnabled} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: "redeemReserve", args: [owner.address], label: "prepare reserve redemption" }])}>Prepare reserve payout</Button><Button disabled={!ready || !data.user.claimable || !m.settlement.claimsEnabled || m.settlement.recoveryRequired} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: "claimTrader", args: [owner.address], label: "claim reserve payout to wallet" }])}>Claim prepared payout</Button></div>}
      <p className="mt-3 text-xs text-fg-3">Notice applies to your current shares. Adding shares requires a new notice. Reserve cash and coverage slack are not a share redemption quote.</p>
    </div>
  </section>;
}
