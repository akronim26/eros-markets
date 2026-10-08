"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import type { Address } from "viem";
import { privyRequest, usePermissions } from "@/lib/privy-api";
import { RULE_KINDS, type RuleKind } from "@/lib/protection";
import type { MarketSnapshot, TraderSnapshot } from "@/lib/reads";
import { lotsToClaims, parseClaimsToLots, parsePriceToTick } from "@/lib/units";
import { explorerTx } from "@/config/chain";
import { useWalletSession } from "./wallet-session";
import { useOwner } from "./wallet";
import { FieldError, useFieldErrors, LoadingPanel } from "./feedback";
import { Button } from "./ui";
import { createWalletGuard } from "@/lib/wallet-safety";
import { chain } from "@/config/chain";
const LABELS: Record<RuleKind, string> = { stop_loss: "Stop loss", take_profit: "Take profit", auto_cancel: "Cancel before close", risk_guard: "Margin guard", backing_guard: "Backing floor guard", claim_delivery: "Deliver settlement claim" };
type State = { configured: boolean; workerOnline: boolean; claimDelivery: boolean; rules: { id: string; engine: string; body: string; status: string; message?: string; hash?: string }[]; journal: { id: number; block: string; message: string; hash?: string }[] };
export function ProtectionPanel({ engine, m, t, readUnavailable = false }: { engine: Address; m: MarketSnapshot; t?: TraderSnapshot; readUnavailable?: boolean }) {
  const session = useWalletSession();
  const config = useConfig();
  const owner = useOwner(), qc = useQueryClient(), permissions = usePermissions(owner.address);
  const [kind, setKind] = useState<RuleKind>("stop_loss"), [trigger, setTrigger] = useState(""), [limit, setLimit] = useState(""), [size, setSize] = useState(""), [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const q = useQuery({ queryKey: ["protection", owner.address, session.getSnapshot().version], enabled: !!owner.address && session.embedded, queryFn: () => privyRequest<State>(`/api/protection?wallet=${owner.address}`), refetchInterval: 10000, retry: false });
  const grant = permissions.data?.modes.find((p) => p.mode === "protect" && p.granted && p.engines.includes(engine.toLowerCase()));
  const reduction = !["auto_cancel", "claim_delivery"].includes(kind);
  const triggered = ["stop_loss", "take_profit"].includes(kind);
  const fieldErrors = { hours: "", trigger: "", limit: "", size: "" };
  if (!Number.isInteger(Number(hours)) || Number(hours) < 1 || Number(hours) > 168) fieldErrors.hours = "Choose a whole number from 1 to 168 hours.";
  if (triggered) { try { parsePriceToTick(trigger); } catch { fieldErrors.trigger = "Enter a trigger price from 0.001 to 0.999."; } }
  if (reduction) {
    try { parsePriceToTick(limit); } catch { fieldErrors.limit = "Enter a limit price from 0.001 to 0.999."; }
    try { if (!parseClaimsToLots(size)) fieldErrors.size = "Enter at least 0.001 claims."; } catch { fieldErrors.size = "Enter a positive claim size with up to 3 decimals."; }
  }
  const validation = useFieldErrors(fieldErrors);
  async function update(body: unknown) {
    if (busy || !owner.address) return;
    setBusy(true); setError("");
    let stop: (() => void) | undefined;
    try {
      const guard = createWalletGuard(session.getSnapshot, owner.address, chain.id);
      stop = config.subscribe((s) => s, guard.observe);
      await privyRequest("/api/protection", body, guard.assertCurrent);
      guard.assertCurrent();
    } catch (e) { setError((e as Error).message); }
    finally {
      stop?.();
      // A timed-out response or a wallet switch does not undo a saved rule.
      try { await qc.invalidateQueries({ queryKey: ["protection"] }); }
      finally { setBusy(false); }
    }
  }
  function create() {
    if (!validation.reveal()) return;
    try {
      const h = Number(hours);
      if (!Number.isInteger(h) || h < 1 || h > 168) throw new Error("Choose a duration from 1 to 168 hours.");
      const reduction = !["auto_cancel", "claim_delivery"].includes(kind);
      const lots = reduction ? parseClaimsToLots(size) : 1n;
      if (!lots) throw new Error("Enter a size to protect.");
      void update({ action: "create", wallet: owner.address, engine, rule: { kind, triggerTick: ["stop_loss", "take_profit"].includes(kind) ? parsePriceToTick(trigger) : 500, limitTick: reduction ? parsePriceToTick(limit) : 500, maxLots: lots.toString(), long: (t?.account?.preview.positionLots ?? 0n) > 0n, expires: Math.floor(Date.now() / 1000) + h * 3600 } });
    } catch (e) { setError((e as Error).message); }
  }
  const field = "mt-1 h-10 w-full border border-line-strong bg-ground px-2 text-sm";
  return <section className="p-4" aria-label="Position protection">
    <h3 className="text-base font-semibold">Position protection</h3><p className="mt-2 max-w-2xl text-sm text-fg-3">Set a rule for your Privy wallet. Triggered trades use reduce-only IOC orders at your chosen limit; thin liquidity can leave part or all of your position open.</p>
    {!owner.address ? <p className="mt-4 text-sm text-fg-3">Log in to configure protection.</p> : !session.embedded ? <p className="mt-4 text-sm text-fg-3">Background protection requires an embedded Privy wallet. Your connected wallet can trade with normal wallet confirmations.</p> : q.isPending ? <div className="mt-4"><LoadingPanel label="Checking protection availability" /></div> : q.isError ? <p role="alert" className="mt-4 text-sm text-ask">Protection service unavailable. <button className="underline" onClick={() => q.refetch()}>Retry</button></p> : !q.data?.configured ? <p className="mt-4 text-sm text-fg-3">Background signing awaits server configuration. No rules are running.</p> : <>
      <p className="my-4 text-xs text-fg-3">Worker: {q.data.workerOnline ? "online" : "offline — rules cannot fire now"}. Price triggers wait for a valid engine mark. Each rule submits at most one transaction.</p>
      {!grant && <p className="mb-4 text-sm text-fg-2">Grant Background protection in your wallet&apos;s Trading permissions to enable automatic orders.</p>}
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <label className="text-xs">Rule<select className={field} value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>{RULE_KINDS.filter((k) => (m.listing.deploymentCapX > 1n || !["risk_guard", "backing_guard"].includes(k)) && (k !== "claim_delivery" || q.data?.claimDelivery)).map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}</select></label>
        <label className="text-xs">Expires in hours<input className={field} type="number" min="1" max="168" value={hours} {...validation.props("hours")} onChange={(e) => setHours(e.target.value)} /><FieldError id={validation.errorId("hours")}>{validation.message("hours")}</FieldError></label>
        {["stop_loss", "take_profit"].includes(kind) && <label className="text-xs">Trigger mark (YES)<input className={field} inputMode="decimal" placeholder="0.500" value={trigger} {...validation.props("trigger")} onChange={(e) => setTrigger(e.target.value)} /><FieldError id={validation.errorId("trigger")}>{validation.message("trigger")}</FieldError></label>}
        {!["auto_cancel", "claim_delivery"].includes(kind) && <><label className="text-xs">Worst acceptable YES price<input className={field} inputMode="decimal" placeholder="0.450" value={limit} {...validation.props("limit")} onChange={(e) => setLimit(e.target.value)} /><FieldError id={validation.errorId("limit")}>{validation.message("limit")}</FieldError></label><label className="text-xs">Maximum claims to close<input className={field} inputMode="decimal" value={size} {...validation.props("size")} onChange={(e) => setSize(e.target.value)} /><FieldError id={validation.errorId("size")}>{validation.message("size")}</FieldError><button className="mt-1 underline" onClick={() => { const n = t?.account?.preview.positionLots ?? 0n; setSize(lotsToClaims(n < 0n ? -n : n)); }}>Use current position size</button></label></>}
        <Button variant="primary" size="lg" className="self-end" disabled={busy || owner.wrongChain || readUnavailable || t?.block !== m.block || !q.data.workerOnline || (kind !== "claim_delivery" && !grant)} onClick={create}>{busy ? "Saving rule…" : "Create protection rule"}</Button>
      </div>
      <div className="mt-6 grid gap-3">{q.data.rules.filter((r) => r.engine === engine.toLowerCase()).map((r) => <div key={r.id} className="border border-line p-3 text-xs"><div className="flex flex-wrap justify-between gap-3"><span className="font-medium">{LABELS[JSON.parse(r.body).kind as RuleKind]} · {r.status}</span>{r.status === "active" && <Button disabled={busy} onClick={() => update({ action: "cancel", id: r.id })}>Cancel rule</Button>}</div>{r.message && <p className="mt-2 text-fg-3">{r.message}</p>}{r.hash && <a className="mt-2 inline-block underline" href={explorerTx(r.hash)} target="_blank" rel="noreferrer">View transaction ↗</a>}</div>)}</div>
      {!!q.data.journal.length && <details className="mt-4"><summary className="label cursor-pointer">Protection activity</summary><ul className="mt-3 grid gap-2 text-xs text-fg-3">{q.data.journal.map((j) => <li key={j.id}>Block {j.block}: {j.message}{j.hash && <> · <a className="underline" href={explorerTx(j.hash)} target="_blank" rel="noreferrer">Transaction ↗</a></>}</li>)}</ul></details>}
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-ask">{error}</p>}
  </section>;
}
