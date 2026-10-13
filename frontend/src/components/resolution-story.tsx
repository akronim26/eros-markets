"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Abi, Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { explorerTx } from "@/config/chain";
import { deployment, type MarketManifest } from "@/config/deployment";
import { ORACLE_OUTCOME, ORACLE_PATH } from "@/lib/enums";
import { useNative, useResolutionEvents, type NativeSnapshot } from "@/lib/native";
import { client, type MarketSnapshot } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { atomsToUsdc, fmtDuration, fmtUtc } from "@/lib/units";
import type { ResolutionEvent } from "@/server/resolution-events";
import { TxFeedback } from "./tx-feedback";
import { Button, Chip, cx } from "./ui";
import { useOwner } from "./wallet";

/** Engine FinalOutcome: UNSET, NO, YES, INVALID (differs from the oracle's NONE, YES, NO, INVALID). */
const ENGINE_OUTCOME = ["—", "NO", "YES", "INVALID"] as const;
const FINAL_REASON = ["—", "assertion accepted", "YES and NO both rejected", "void deadline reached"] as const;
const wad3 = (wad: bigint) => (Number(wad / 10n ** 15n) / 1000).toFixed(3);
const time = (t: number) => new Date(t * 1000).toISOString().slice(11, 19) + " UTC";

type Step = { key: string; title: string; status: "done" | "active" | "pending" | "skipped"; at?: number; tx?: string; body: React.ReactNode };

/** Facts derived only from on-chain events and current reads; nothing here is inferred from off-chain state. */
export function resolutionFacts(events: ResolutionEvent[], scheduledT: number) {
  const first = (kind: string) => events.find((e) => e.kind === kind);
  const halt = first("HaltRecorded");
  const finalized = first("Finalized");
  const early = !!first("EarlyCheckRequested") || (halt?.args.early === true);
  const haltedAt = halt ? Number(halt.args.haltedAt) : undefined;
  return {
    early, haltedAt, earlyBy: early && haltedAt !== undefined && haltedAt < scheduledT ? scheduledT - haltedAt : undefined,
    requested: first("EarlyCheckRequested"), halt, engineHalt: first("MarketHalted"),
    proposal: events.find((e) => e.kind === "ProposalRecorded" || e.kind === "ProposedL1"),
    asserted: events.filter((e) => e.kind === "Asserted"), disputes: events.filter((e) => e.kind === "Disputed"),
    rejected: events.filter((e) => e.kind === "AssertionRejected"),
    finalized, voided: first("Voided"), accepted: first("OracleFinalityAccepted"),
    snapshot: events.filter((e) => e.kind === "SnapshotPreparationProgress").at(-1),
    payout: events.filter((e) => e.kind === "PayoutPreparationProgress").at(-1),
    claimsEnabled: first("ClaimsEnabled"), synced: first("ResolutionSynced"),
    redeemed: events.filter((e) => e.kind === "Redeemed"),
  };
}

/** One-line status shown above the terminal once a market has halted. */
export function ResolutionBanner({ manifest, m, onOpen }: { manifest: MarketManifest; m?: MarketSnapshot; onOpen: () => void }) {
  const ev = useResolutionEvents(manifest.engine);
  if (!m?.halted || !ev.data) return null;
  const f = resolutionFacts(ev.data.events, Number(m.listing.scheduledT));
  const outcome = f.finalized ? ORACLE_OUTCOME[Number(f.finalized.args.outcome)] : undefined;
  return <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-x border-b border-line bg-panel px-3 py-2 text-xs text-fg-2">
    <Chip tone={outcome ? "neutral" : "warn"}>{f.early ? "Resolved early" : "Halted"}{outcome ? ` · ${outcome}` : ", awaiting outcome"}</Chip>
    {f.earlyBy !== undefined && <span><span className="text-fg">{fmtDuration(f.earlyBy)}</span> before the scheduled close ({fmtUtc(m.listing.scheduledT)})</span>}
    {f.haltedAt !== undefined && <span>Trading halted {fmtUtc(f.haltedAt)}</span>}
    {f.finalized && <span>Final {fmtUtc(f.finalized.timestamp)}</span>}
    <button className="text-signal-text underline" onClick={onOpen}>How it resolved</button>
  </div>;
}

export function ResolutionStory({ manifest, m }: { manifest: MarketManifest; m?: MarketSnapshot }) {
  const owner = useOwner();
  const ev = useResolutionEvents(manifest.engine);
  const native = useNative(manifest.engine, owner.address, m?.block);
  if (ev.isPending || !m) return <p className="p-4 text-xs text-fg-3">Reading the resolution history…</p>;
  if (ev.isError) return <p role="alert" className="p-4 text-xs text-ask">Resolution history is unavailable. <button className="underline" onClick={() => ev.refetch()}>Retry</button></p>;
  const T = Number(m.listing.scheduledT);
  const f = resolutionFacts(ev.data.events, T);
  const now = Math.floor(Date.now() / 1000);
  const s = m.settlement;
  const n = native.data;
  const steps: Step[] = [];

  steps.push({ key: "trading", title: "Trading", status: m.halted ? "done" : "active", body: <>
    Perp trading runs until the event is decided or the scheduled close at <b className="text-fg">{fmtUtc(T)}</b>, whichever comes first.
    {n && <> The {n.binding.yesSymbol}/{n.binding.noSymbol} tokens trade on Kuru alongside.</>}
  </> });
  if (f.requested || f.early) steps.push({ key: "request", title: "Event happened early: resolution requested", status: f.requested ? "done" : "pending",
    at: f.requested?.timestamp, tx: f.requested?.txHash, body: <>
      The outcome became known before the scheduled close, so an early resolution was requested instead of waiting for {fmtUtc(T)}.
    </> });
  steps.push({ key: "halt", title: f.early ? "Trading halted early" : "Trading halted", status: f.halt ? "done" : "pending", at: f.haltedAt, tx: f.halt?.txHash, body: f.halt ? <>
    {f.earlyBy !== undefined && <><b className="text-fg">{fmtDuration(f.earlyBy)}</b> before the scheduled close. </>}
    New perp orders stopped and every position was frozen at the halt snapshot
    {f.engineHalt && <> ({String(f.engineHalt.args.frozenAccountCount)} accounts, open interest {(Number(f.engineHalt.args.oiHaltLots) / 1000).toFixed(3)} claims)</>}.
    Nobody can trade on information after the event.
  </> : <>Trading halts when the oracle records the event, or at the scheduled close.</> });
  steps.push({ key: "propose", title: f.proposal ? `Outcome proposed: ${ORACLE_OUTCOME[Number(f.proposal.args.outcome)]}` : "Outcome proposed",
    status: f.proposal ? "done" : f.halt ? "active" : "pending", at: f.proposal?.timestamp, tx: f.proposal?.txHash, body: f.proposal ? <>
      Proposed through <b className="text-fg">{ORACLE_PATH[Number(f.proposal.args.path)]}</b> with its evidence hash recorded on chain.
    </> : <>After the halt, the oracle&apos;s data feed, model panel or committee proposes YES, NO or INVALID.</> });
  const assertion = f.asserted.at(-1);
  const expires = assertion ? Number(assertion.args.expiresAt) : undefined;
  steps.push({ key: "challenge", title: "Challenge window", status: f.finalized || f.voided ? "done" : assertion ? "active" : "pending",
    at: assertion?.timestamp, tx: assertion?.txHash, body: assertion ? <>
      The proposal was posted with a <b className="text-fg">{atomsToUsdc(BigInt(String(assertion.args.bond)))} {deployment.risk.collateralSymbol}</b> bond.
      Anyone could dispute it for {fmtDuration(Number(assertion.args.liveness))}, until {time(expires!)}{expires! > now && !f.finalized ? " (open now)" : ""}.
      {f.disputes.length > 0 ? <> Disputed {f.disputes.length}×; the sandbox arbiter decided.</> : <> No dispute was raised.</>}
      {f.rejected.length > 0 && <> {f.rejected.length} proposal(s) were rejected and retried.</>}
      <span className="block text-fg-3">Testnet: disputes go to an Eros-run UMA sandbox, not UMA voters.</span>
    </> : <>Every proposal carries a bond and a dispute window before it can become final.</> });
  steps.push({ key: "final", title: f.finalized ? `Final: ${ORACLE_OUTCOME[Number(f.finalized.args.outcome)]}` : f.voided ? "Voided" : "Final outcome",
    status: f.finalized || f.voided ? "done" : "pending", at: f.finalized?.timestamp, tx: f.finalized?.txHash, body: f.finalized ? <>
      Finalized ({FINAL_REASON[Number(f.finalized.args.reason)]}).
      {f.accepted && <> The perp engine accepted it in the same transaction.</>}
    </> : <>If nothing becomes final in time, the market resolves INVALID at its void deadline.</> });

  const prepared = s.claimsEnabled;
  steps.push({ key: "perp", title: prepared ? "Perp claims open" : "Perp settlement", status: prepared ? "done" : s.oracleFinalityAccepted ? "active" : "pending",
    at: f.claimsEnabled?.timestamp, tx: f.claimsEnabled?.txHash, body: <>
      Perp positions settle at <b className="text-fg">{s.oracleFinalityAccepted ? `${wad3(s.finalOutcome === 2 ? 10n ** 18n : s.finalOutcome === 1 ? 0n : s.settlementPriceE18)} per claim` : "the final price"}</b>
      {s.oracleFinalityAccepted && <> ({ENGINE_OUTCOME[s.finalOutcome]})</>}.
      {prepared ? <> Payouts are prepared; holders claim from Manage collateral.</>
        : s.oracleFinalityAccepted ? <> Payouts are being prepared: snapshot {String(s.snapshotCursor)}/{String(s.accountCount)} accounts, payouts {String(s.payoutCursor)}/{String(s.accountCount)}. Anyone can run these steps.</>
        : <> Settlement starts once the outcome is final.</>}
      {s.oracleFinalityAccepted && !prepared && <PrepareSettlement engine={manifest.engine} />}
    </> });
  if (n) steps.push({ key: "native", title: n.resolved ? "Outcome tokens redeemable" : "Outcome tokens", status: n.resolved ? "done" : s.oracleFinalityAccepted ? "active" : "pending",
    at: f.synced?.timestamp, tx: f.synced?.txHash, body: <NativeRedeem n={n} canSync={s.oracleFinalityAccepted} redeemedCount={f.redeemed.length} /> });

  return <section aria-label="How this market resolves" className="p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold text-fg">How this market {m.halted ? "resolved" : "resolves"}</h2>
      {f.early && <Chip tone="signal">Resolved early</Chip>}
      {f.finalized && <Chip tone="neutral">Final: {ORACLE_OUTCOME[Number(f.finalized.args.outcome)]}</Chip>}
    </div>
    <ol className="mt-4 flex flex-col">
      {steps.map((step, i) => <li key={step.key} className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0">
        {i < steps.length - 1 && <span aria-hidden className={cx("absolute top-4 bottom-0 left-[9px] w-px", step.status === "done" ? "bg-signal" : "bg-line")} />}
        <span aria-hidden className={cx("relative z-10 mt-1 h-[11px] w-[11px] justify-self-center border",
          step.status === "done" ? "border-signal bg-signal" : step.status === "active" ? "border-signal bg-ground" : "border-line-strong bg-ground")} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-3 text-xs">
            <span className={cx("font-semibold", step.status === "pending" ? "text-fg-3" : "text-fg")}>{step.title}</span>
            <span className="sr-only">{step.status === "done" ? "complete" : step.status === "active" ? "in progress" : "not yet"}</span>
            {step.at !== undefined && <span className="tnum text-fg-3">{fmtUtc(step.at).slice(0, 10)} {time(step.at)}</span>}
            {step.tx && <a href={explorerTx(step.tx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-3 underline hover:text-fg">tx<ExternalLink size={10} aria-hidden /></a>}
          </p>
          <div className="mt-1 max-w-[72ch] text-xs leading-relaxed text-fg-2">{step.body}</div>
        </div>
      </li>)}
    </ol>
  </section>;
}

/** Runs the next permissionless settlement step, in the keeper's order: finish, payout chunk, snapshot chunk. */
function PrepareSettlement({ engine }: { engine: Address }) {
  const owner = useOwner();
  const tx = useTx();
  const [note, setNote] = useState<string>();
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  async function next() {
    if (!owner.address) return;
    setNote(undefined);
    const candidates = [
      { functionName: "finishPreparation", args: [], label: "finish settlement preparation" },
      { functionName: "preparePayoutChunk", args: [32n], label: "prepare payouts" },
      { functionName: "prepareSnapshotChunk", args: [32n], label: "prepare settlement snapshot" },
    ] as const;
    for (const c of candidates) {
      try { await client.simulateContract({ address: engine, abi: engineAbi, functionName: c.functionName, args: c.args as never, account: owner.address }); }
      catch { continue; }
      await tx.run(owner.address, [{ address: engine, abi: engineAbi as Abi, functionName: c.functionName, args: c.args, label: c.label }]);
      return;
    }
    setNote("No settlement step can run right now; refresh in a moment.");
  }
  if (!owner.address) return <span className="mt-2 block text-fg-3">Log in to run the next step yourself.</span>;
  return <span className="mt-2 flex flex-col gap-2">
    <Button size="md" disabled={busy || owner.wrongChain} onClick={next}>Run next settlement step</Button>
    {note && <span className="text-fg-3">{note}</span>}
    <TxFeedback state={tx.state} />
  </span>;
}

/** Native YES/NO: payout per token, the viewer's balances and one-click redemption at the latched price. */
function NativeRedeem({ n, canSync, redeemedCount }: { n: NativeSnapshot; canSync: boolean; redeemedCount: number }) {
  const owner = useOwner();
  const tx = useTx();
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const sym = deployment.risk.collateralSymbol;
  const yesPays = n.resolved ? wad3(n.payoutYesWad) : undefined, noPays = n.resolved ? wad3(10n ** 18n - n.payoutYesWad) : undefined;
  const w = n.wallet;
  return <>
    {n.resolved ? <>
      The vault copied the final outcome from the engine: <b className="text-fg">1 {n.binding.yesSymbol} pays {yesPays} {sym}</b>, 1 {n.binding.noSymbol} pays {noPays} {sym}.
      Each pair is fully backed by collateral held in the vault, so redemption never depends on perp settlement.
      <span className="mt-1 block tnum text-fg-3">{atomsToUsdc(n.totalRedeemed)} of {atomsToUsdc(n.outstandingSets)} {sym} redeemed so far ({redeemedCount} redemption{redeemedCount === 1 ? "" : "s"}).</span>
    </> : canSync ? <>The outcome is final; the vault has not copied it yet. Anyone can sync it, then holders redeem.</>
      : <>When the outcome is final, the vault pays {sym} for {n.binding.yesSymbol} and {n.binding.noSymbol} at the final price (YES 1, NO 0, INVALID the captured price).</>}
    {owner.address && w && <span className="mt-3 grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 border border-line p-3 tnum">
      <span className="text-fg-3">Your {n.binding.yesSymbol}</span><span className="text-right text-fg">{atomsToUsdc(w.yes)}</span>
      <span className="text-fg-3">Your {n.binding.noSymbol}</span><span className="text-right text-fg">{atomsToUsdc(w.no)}</span>
      {n.resolved && <><span className="text-fg-3">You receive</span><span className="text-right font-semibold text-fg">{atomsToUsdc(w.redeemable)} {sym}</span></>}
    </span>}
    {owner.address && w && n.resolved && (w.yes > 0n || w.no > 0n) && <span className="mt-1 block text-fg-3">Tokens still in Kuru orders or Kuru margin are not in your wallet: cancel and withdraw them on Kuru first.</span>}
    <span className="mt-2 flex flex-col gap-2">
      {!owner.address ? <span className="text-fg-3">Log in to see and redeem your tokens.</span>
        : !n.resolved && canSync ? <Button size="md" disabled={busy || owner.wrongChain} onClick={() => tx.run(owner.address!, [{ address: n.binding.vault, abi: nativeVaultAbi as Abi, functionName: "syncResolution", args: [], label: "sync the final outcome" }])}>Sync outcome to the vault</Button>
        : n.resolved && w && (w.yes > 0n || w.no > 0n) ? <Button variant="primary" size="md" disabled={busy || owner.wrongChain} onClick={() => tx.run(owner.address!, [{ address: n.binding.vault, abi: nativeVaultAbi as Abi, functionName: "redeem", args: [w.yes, w.no, owner.address!], label: "redeem outcome tokens" }])}>Redeem for {atomsToUsdc(w.redeemable)} {sym}</Button>
        : null}
      <TxFeedback state={tx.state} />
    </span>
  </>;
}
