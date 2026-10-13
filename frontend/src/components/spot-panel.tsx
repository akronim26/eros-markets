"use client";

import { useState } from "react";
import type { Abi, Address } from "viem";
import { KURU_MARGIN, kuruBookAbi, kuruMarginAbi } from "@/abi/kuru";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { nativeBinding } from "@/config/native";
import { deployment } from "@/config/deployment";
import { useSpot, type Outcome, type SpotSnapshot } from "@/lib/spot";
import { askLockAtoms, bidLockAtoms, minOut, previewBuy, previewSell, QUOTE_UNIT_ATOMS } from "@/lib/spot-math";
import { useTx } from "@/lib/tx";
import { atomsToUsdc, parseClaimsToLots, parsePriceToTick, parseUsdcToAtoms, tickToPrice } from "@/lib/units";
import { TxFeedback } from "./tx-feedback";
import { Button, cx, selectionKeys } from "./ui";
import { useOwner } from "./wallet";

const erc20ApproveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; label: string };
const SLIPPAGE = [50, 100, 200] as const;
const claims = (atoms: bigint) => atomsToUsdc(atoms, 3);

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { v: T; text: string; tone?: "bid" | "ask" }[]; onChange: (v: T) => void }) {
  return <div role="radiogroup" aria-label={label} className={cx("grid gap-2", options.length === 2 ? "grid-cols-2" : "grid-cols-3")} onKeyDown={selectionKeys}>
    {options.map((o) => <button key={o.v} type="button" role="radio" aria-checked={value === o.v} tabIndex={value === o.v ? 0 : -1} onClick={() => onChange(o.v)}
      className={cx("ui-toggle h-9 border text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        value === o.v ? o.tone === "bid" ? "border-bid bg-bid text-on-bid" : o.tone === "ask" ? "border-ask bg-ask text-on-ask" : "border-fg bg-fg text-ground"
          : "border-line-strong bg-panel text-fg-2 hover:bg-press hover:text-fg")}>{o.text}</button>)}
  </div>;
}

function Field({ id, label, value, onChange, hint, suffix }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: React.ReactNode; suffix?: string }) {
  return <div className="flex flex-col gap-1">
    <label htmlFor={id} className="label text-2xs text-fg-3">{label}</label>
    <div className="flex items-center border border-line-strong bg-ground focus-within:outline-2 focus-within:outline-signal">
      <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.000" className="tnum min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-fg outline-none" />
      {suffix && <span className="px-3 text-xs text-fg-3">{suffix}</span>}
    </div>
    {hint && <span className="text-2xs text-fg-3">{hint}</span>}
  </div>;
}

/**
 * Spot trading of an Eros native market's YES/NO tokens on its Kuru books (NM-I01/I03/I04).
 * Market orders settle wallet-to-wallet (no Kuru deposit); limit orders rest in Kuru's margin account.
 * Every target is verified against the reviewed native binding before signing (lib/native.ts).
 */
export function SpotPanel({ engine, block, halted }: { engine: Address; block?: bigint; halted: boolean }) {
  const owner = useOwner();
  const spot = useSpot(engine, owner.address, block);
  const b = nativeBinding(engine)!;
  const tx = useTx();
  const [mode, setMode] = useState<"trade" | "split" | "orders">("trade");
  const [outcome, setOutcome] = useState<Outcome>("yes");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [slip, setSlip] = useState<number>(100);
  const [setAmt, setSetAmt] = useState("");
  const s = spot.data;
  const sym = deployment.risk.collateralSymbol;
  const tokenSym = outcome === "yes" ? b.yesSymbol : b.noSymbol;
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const book = outcome === "yes" ? b.yesBook : b.noBook;
  const token = outcome === "yes" ? b.yesToken : b.noToken;
  const l2 = s?.books[outcome];
  const best = (o: Outcome) => s ? { bid: s.books[o].bids[0]?.tick, ask: s.books[o].asks[0]?.tick } : undefined;
  const run = (calls: Call[]) => owner.address && tx.run(owner.address, calls);
  const approve = (tokenAddr: Address, spender: Address, atoms: bigint, label: string): Call => ({ address: tokenAddr, abi: erc20ApproveAbi as unknown as Abi, functionName: "approve", args: [spender, atoms], label });

  // ---- trade ticket: parse, preview and the exact calls
  let error = "", calls: Call[] = [], preview: React.ReactNode = null;
  try {
    if (!s || !l2) throw new Error("");
    if (kind === "market") {
      if (!amount) throw new Error("");
      if (side === "buy") {
        const spend = (parseUsdcToAtoms(amount) / QUOTE_UNIT_ATOMS) * QUOTE_UNIT_ATOMS;
        if (spend === 0n) throw new Error(`Spend at least 0.001 ${sym}.`);
        const f = previewBuy(l2.asks, spend, s.takerFeeBps[outcome]);
        if (f.lots === 0n) throw new Error(`No ${tokenSym} offered on Kuru right now.`);
        if (s.wallet && spend > s.wallet.usdc) throw new Error(`Wallet has ${atomsToUsdc(s.wallet.usdc)} ${sym}.`);
        const floor = minOut(f.outAtoms, slip);
        preview = <>You receive about <b className="text-fg">{claims(f.outAtoms)} {tokenSym}</b> for {atomsToUsdc(f.inAtoms, 3)} {sym} (avg {(Number(f.inAtoms * 1000n / f.outAtoms) / 1000).toFixed(3)}, worst {tickToPrice(f.worstTick!)}).{!f.complete && " The book is thinner than your order: the unfilled part is returned."} Minimum {claims(floor)} or it reverts.</>;
        calls = [...((s.allowance?.[outcome === "yes" ? "usdcYesBook" : "usdcNoBook"] ?? 0n) < spend ? [approve(b.collateral, book, spend, `approve ${sym} for Kuru`)] : []),
          { address: book, abi: kuruBookAbi as unknown as Abi, functionName: "placeAndExecuteMarketBuy", args: [spend / QUOTE_UNIT_ATOMS, floor, false, false], label: `buy ${tokenSym}` }];
      } else {
        const lots = parseClaimsToLots(amount);
        if (lots === 0n) throw new Error("Enter a size of at least 0.001.");
        const have = s.wallet?.[outcome] ?? 0n;
        if (s.wallet && lots * 1000n > have) throw new Error(`Wallet has ${claims(have)} ${tokenSym}.`);
        const f = previewSell(l2.bids, lots, s.takerFeeBps[outcome]);
        if (f.lots === 0n) throw new Error(`No bids for ${tokenSym} on Kuru right now.`);
        const floor = minOut(f.outAtoms, slip);
        preview = <>You receive about <b className="text-fg">{atomsToUsdc(f.outAtoms, 3)} {sym}</b> for {claims(f.inAtoms)} {tokenSym} (worst {tickToPrice(f.worstTick!)}).{!f.complete && " Bids cover only part of your order: the rest stays in your wallet."} Minimum {atomsToUsdc(floor, 3)} or it reverts.</>;
        const needs = lots * 1000n;
        calls = [...((s.allowance?.[outcome === "yes" ? "yesBook" : "noBook"] ?? 0n) < needs ? [approve(token, book, needs, `approve ${tokenSym} for Kuru`)] : []),
          { address: book, abi: kuruBookAbi as unknown as Abi, functionName: "placeAndExecuteMarketSell", args: [lots, floor, false, false], label: `sell ${tokenSym}` }];
      }
    } else {
      if (!amount || !price) throw new Error("");
      const tick = parsePriceToTick(price), lots = parseClaimsToLots(amount);
      if (lots === 0n) throw new Error("Enter a size of at least 0.001.");
      const bb = best(outcome)!;
      if (side === "buy" && bb.ask !== undefined && tick >= bb.ask) throw new Error(`A post-only bid must be below the best ask ${tickToPrice(bb.ask)}; use Market to buy now.`);
      if (side === "sell" && bb.bid !== undefined && tick <= bb.bid) throw new Error(`A post-only ask must be above the best bid ${tickToPrice(bb.bid)}; use Market to sell now.`);
      const lockToken = side === "buy" ? b.collateral : token;
      const lock = side === "buy" ? bidLockAtoms(tick, lots) : askLockAtoms(lots);
      const inMargin = side === "buy" ? s.margin?.usdc ?? 0n : s.margin?.[outcome] ?? 0n;
      const shortfall = lock > inMargin ? lock - inMargin : 0n;
      const wallet = side === "buy" ? s.wallet?.usdc ?? 0n : s.wallet?.[outcome] ?? 0n;
      if (s.wallet && shortfall > wallet) throw new Error(`Needs ${side === "buy" ? `${atomsToUsdc(lock, 3)} ${sym}` : `${claims(lock)} ${tokenSym}`}; wallet plus Kuru balance is short.`);
      const allowKey = side === "buy" ? "usdcMargin" : outcome === "yes" ? "yesMargin" : "noMargin";
      preview = <>Rests on Kuru at {tickToPrice(tick)} until filled or cancelled; locks {side === "buy" ? `${atomsToUsdc(lock, 3)} ${sym}` : `${claims(lock)} ${tokenSym}`} in your Kuru balance{shortfall > 0n ? ` (deposits ${side === "buy" ? atomsToUsdc(shortfall, 3) : claims(shortfall)} from your wallet first)` : ""}. Fills arrive in your Kuru balance; withdraw them below.</>;
      calls = [
        ...(shortfall > 0n && (s.allowance?.[allowKey] ?? 0n) < shortfall ? [approve(lockToken, KURU_MARGIN, shortfall, "approve Kuru deposit")] : []),
        ...(shortfall > 0n ? [{ address: KURU_MARGIN, abi: kuruMarginAbi as unknown as Abi, functionName: "deposit", args: [owner.address, lockToken, shortfall], label: "deposit to Kuru" }] : []),
        { address: book, abi: kuruBookAbi as unknown as Abi, functionName: side === "buy" ? "addBuyOrder" : "addSellOrder", args: [tick, lots, true], label: `post ${side === "buy" ? "bid" : "ask"} for ${tokenSym}` },
      ];
    }
  } catch (e) { error = (e as Error).message; calls = []; }

  // ---- split / merge
  let setError = "", setAtoms = 0n;
  try { if (setAmt) { setAtoms = parseUsdcToAtoms(setAmt); if (!setAtoms) throw new Error(`Enter an amount greater than zero.`); } } catch (e) { setError = (e as Error).message; }

  const blocked = !owner.address ? "Log in to trade" : owner.wrongChain ? "Switch to Monad testnet" : spot.isError ? "Kuru reads unavailable" : !s ? "Reading Kuru…" : "";
  const marginTotal = s?.margin ? s.margin.usdc + s.margin.yes + s.margin.no : 0n;

  return <section aria-label="Spot trading on Kuru" className="flex flex-col gap-3 p-3">
    <div className="grid grid-cols-2 gap-2 tnum text-xs">
      {(["yes", "no"] as const).map((o) => { const q = best(o); return <button key={o} type="button" onClick={() => setOutcome(o)} aria-pressed={outcome === o}
        className={cx("flex flex-col items-start border px-3 py-2 text-left", outcome === o ? "border-signal bg-panel" : "border-line bg-ground hover:bg-hover")}>
        <span className="label text-2xs text-fg-3">{o === "yes" ? b.yesSymbol : b.noSymbol}</span>
        <span className="text-fg"><span className="text-bid">{q?.bid !== undefined ? tickToPrice(q.bid) : "—"}</span> / <span className="text-ask">{q?.ask !== undefined ? tickToPrice(q.ask) : "—"}</span></span>
      </button>; })}
    </div>
    <Seg label="Spot action" value={mode} onChange={setMode} options={[{ v: "trade", text: "Trade" }, { v: "split", text: "Split / merge" }, { v: "orders", text: `Kuru${s?.orders?.length ? ` · ${s.orders.length}` : ""}` }]} />

    {mode === "trade" && <>
      <Seg label="Side" value={side} onChange={(v) => { setSide(v); setAmount(""); }} options={[{ v: "buy", text: `Buy ${outcome.toUpperCase()}`, tone: "bid" }, { v: "sell", text: `Sell ${outcome.toUpperCase()}`, tone: "ask" }]} />
      <Seg label="Order type" value={kind} onChange={setKind} options={[{ v: "market", text: "Market" }, { v: "limit", text: "Limit (post-only)" }]} />
      {kind === "limit" && <Field id="spot-price" label={`${tokenSym} price`} value={price} onChange={setPrice} suffix={sym} />}
      <Field id="spot-amount" label={kind === "market" && side === "buy" ? `Spend (${sym})` : `Size (${tokenSym})`} value={amount} onChange={setAmount}
        hint={s?.wallet && <>Wallet: {atomsToUsdc(s.wallet.usdc)} {sym} · {claims(s.wallet[outcome])} {tokenSym}</>} />
      {kind === "market" && <div className="flex items-center justify-between text-2xs text-fg-3"><span>Max slippage</span>
        <span className="flex gap-1">{SLIPPAGE.map((v) => <button key={v} type="button" aria-pressed={slip === v} onClick={() => setSlip(v)} className={cx("min-h-7 px-2 border", slip === v ? "border-fg text-fg" : "border-line text-fg-3")}>{v / 100}%</button>)}</span></div>}
      {preview && <p className="text-xs leading-relaxed text-fg-2">{preview}</p>}
      {error && <p role="alert" className="text-xs text-ask">{error}</p>}
      {halted && <p className="text-xs text-fg-3">Event halted: Eros no longer opens new spot orders here. Cancel, withdraw and redeem stay available.</p>}
      <Button variant={side === "buy" ? "bid" : "ask"} size="lg" disabled={!!blocked || halted || busy || !calls.length} onClick={() => run(calls)}>
        {blocked || (calls.length > 1 ? `Approve and ${side} ${tokenSym}` : `${side === "buy" ? "Buy" : "Sell"} ${tokenSym}`)}
      </Button>
    </>}

    {mode === "split" && <>
      <p className="text-xs leading-relaxed text-fg-2">1 {sym} mints 1 {b.yesSymbol} + 1 {b.noSymbol}; one of each merges back to 1 {sym} at any time before resolution. The vault holds the collateral, so every pair is fully backed.</p>
      <Field id="spot-set" label={`Amount (${sym} = pairs)`} value={setAmt} onChange={setSetAmt}
        hint={s?.wallet && <>Wallet: {atomsToUsdc(s.wallet.usdc)} {sym} · {claims(s.wallet.yes)} YES · {claims(s.wallet.no)} NO</>} />
      {setError && <p role="alert" className="text-xs text-ask">{setError}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" disabled={!!blocked || busy || !setAtoms || !s?.issuanceOpen || (s.wallet && setAtoms > s.wallet.usdc)} onClick={() => run([
          ...((s?.allowance?.usdcVault ?? 0n) < setAtoms ? [approve(b.collateral, b.vault, setAtoms, `approve ${sym} for the vault`)] : []),
          { address: b.vault, abi: nativeVaultAbi as unknown as Abi, functionName: "split", args: [setAtoms, owner.address], label: "split into YES + NO" }])}>Split</Button>
        <Button size="lg" disabled={!!blocked || busy || !setAtoms || !!s?.resolved || (!!s?.wallet && (setAtoms > s.wallet.yes || setAtoms > s.wallet.no))} onClick={() => run([
          { address: b.vault, abi: nativeVaultAbi as unknown as Abi, functionName: "merge", args: [setAtoms, owner.address], label: "merge YES + NO" }])}>Merge</Button>
      </div>
      {s && !s.issuanceOpen && <p className="text-xs text-fg-3">New pairs can no longer be minted (event halted or cap reached); merging still works until resolution.</p>}
    </>}

    {mode === "orders" && <>
      {s?.margin && <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 border border-line p-3 text-xs tnum">
        <span className="text-fg-3" /><span className="text-right text-fg-3">Wallet</span><span className="text-right text-fg-3">Kuru</span>
        {([["usdc", sym], ["yes", b.yesSymbol], ["no", b.noSymbol]] as const).map(([k, label]) => <span key={k} className="contents">
          <span className="text-fg-2">{label}</span><span className="text-right text-fg">{k === "usdc" ? atomsToUsdc(s.wallet![k]) : claims(s.wallet![k])}</span><span className="text-right text-fg">{k === "usdc" ? atomsToUsdc(s.margin![k]) : claims(s.margin![k])}</span>
        </span>)}
      </div>}
      <Button size="md" disabled={!!blocked || busy || marginTotal === 0n} onClick={() => run(([["usdc", b.collateral, sym], ["yes", b.yesToken, b.yesSymbol], ["no", b.noToken, b.noSymbol]] as const)
        .filter(([k]) => (s?.margin?.[k] ?? 0n) > 0n)
        .map(([k, addr, label]) => ({ address: KURU_MARGIN, abi: kuruMarginAbi as unknown as Abi, functionName: "withdraw", args: [s!.margin![k], addr], label: `withdraw ${label} from Kuru` })))}>Withdraw all Kuru balances to wallet</Button>
      <p className="text-2xs text-fg-3">Locked amounts behind open orders are not withdrawable until those orders are cancelled.</p>
      <div className="flex items-center justify-between"><span className="label text-2xs text-fg-3">Your open Kuru orders</span>
        {!!s?.orders?.length && <button className="text-xs text-signal-text underline disabled:text-fg-4" disabled={busy} onClick={() => run((["yes", "no"] as const)
          .map((o) => ({ o, ids: s!.orders!.filter((x) => x.outcome === o).map((x) => x.id) })).filter((g) => g.ids.length)
          .map((g) => ({ address: g.o === "yes" ? b.yesBook : b.noBook, abi: kuruBookAbi as unknown as Abi, functionName: "batchCancelOrders", args: [g.ids], label: `cancel ${g.o.toUpperCase()} orders` })))}>Cancel all</button>}</div>
      {!owner.address ? <p className="text-xs text-fg-3">Log in to see your orders.</p> : !s?.orders ? <p className="text-xs text-fg-3">Reading…</p> : s.orders.length === 0 ? <p className="text-xs text-fg-3">No open orders (recent {300} per book scanned).</p>
        : <ul className="flex flex-col text-xs tnum">{s.orders.map((o) => <li key={`${o.outcome}-${o.id}`} className="hair-b flex items-center justify-between py-1.5">
          <span className={o.isBuy ? "text-bid" : "text-ask"}>{o.isBuy ? "Bid" : "Ask"} {o.outcome.toUpperCase()}</span>
          <span className="text-fg">{claims(o.lots * 1000n)} @ {tickToPrice(o.tick)}</span>
          <button className="text-fg-3 underline hover:text-fg disabled:text-fg-4" disabled={busy} onClick={() => run([{ address: o.outcome === "yes" ? b.yesBook : b.noBook, abi: kuruBookAbi as unknown as Abi, functionName: "batchCancelOrders", args: [[o.id]], label: `cancel order ${o.id}` }])}>Cancel</button>
        </li>)}</ul>}
    </>}
    <TxFeedback state={tx.state} />
    <p className="text-2xs leading-relaxed text-fg-3">Trades execute on Kuru&apos;s on-chain order books for these tokens. Test tokens only; Eros does not control Kuru and cannot pause its books.</p>
  </section>;
}

/** Prominent venue switch under the market header: perp on Eros, or the YES/NO tokens on Kuru. */
export function VenueBar({ engine, block, venue, onChange }: { engine: Address; block?: bigint; venue: "perp" | "spot"; onChange: (v: "perp" | "spot") => void }) {
  const spot = useSpot(engine, undefined, block);
  const b = nativeBinding(engine)!;
  const q = (o: Outcome) => { const l = spot.data?.books[o]; return l ? `${l.bids[0] ? tickToPrice(l.bids[0].tick) : "—"} / ${l.asks[0] ? tickToPrice(l.asks[0].tick) : "—"}` : "…"; };
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-x border-b border-line bg-panel px-3 py-2 text-xs">
    <span className="text-fg-2">Trade this event as</span>
    <div role="tablist" aria-label="Trading venue" className="flex gap-2" onKeyDown={selectionKeys}>
      {(["perp", "spot"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={venue === v} tabIndex={venue === v ? 0 : -1} onClick={() => onChange(v)}
        className={cx("min-h-9 border px-3 font-semibold", venue === v ? "border-signal bg-signal text-on-signal" : "border-line-strong bg-ground text-fg hover:bg-hover")}>
        {v === "perp" ? "Perp on Eros (long / short)" : "YES/NO tokens on Kuru"}
      </button>)}
    </div>
    <span className="tnum text-fg-3">Kuru {b.yesSymbol} {q("yes")} · {b.noSymbol} {q("no")}</span>
  </div>;
}

export type { SpotSnapshot };
