"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { Abi, Address } from "viem";
import { KURU_MARGIN, kuruBookAbi, kuruMarginAbi } from "@/abi/kuru";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { explorerTx } from "@/config/chain";
import { deployment, type MarketManifest } from "@/config/deployment";
import { nativeBinding } from "@/config/native";
import { useNative } from "@/lib/native";
import { usePriceSeries } from "@/lib/price-history";
import { useSpot, type Outcome, type SpotSnapshot } from "@/lib/spot";
import { askLockAtoms, bidLockAtoms, minOut, previewBuy, previewSell, QUOTE_UNIT_ATOMS, type L2Level } from "@/lib/spot-math";
import { useTx } from "@/lib/tx";
import { atomsToUsdc, fmtDuration, fmtUtc, parseClaimsToLots, parsePriceToTick, parseUsdcToAtoms, tickToPrice } from "@/lib/units";
import type { KuruTrade } from "@/server/kuru-trades";
import { PriceAxis } from "./price-axis";
import { TxFeedback } from "./tx-feedback";
import { Button, Chip, cx, selectionKeys, Stat } from "./ui";
import { useOwner } from "./wallet";
import styles from "./terminal.module.css";

/**
 * Plain spot exchange view for a native market's YES/NO tokens on Kuru (NM-I01/I03/I04).
 * No leverage, margin requirement, mark, funding or positions: tokens are bought and sold outright,
 * market orders settle wallet-to-wallet and limit orders rest in Kuru's margin account.
 * Every target is verified against the reviewed native binding before signing (lib/native.ts).
 */
const erc20ApproveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; label: string };
const claims = (atoms: bigint) => atomsToUsdc(atoms, 3);
const lotsText = (lots: bigint) => atomsToUsdc(lots * 1000n, 3);
const SLIPPAGE = [50, 100, 200] as const;

function useKuruTrades(engine: Address, enabled = true) {
  return useQuery({ queryKey: ["kuru-trades", engine.toLowerCase()], refetchInterval: 8000, retry: 2, enabled,
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/kuru-trades/${engine}`, { signal, cache: "no-store" });
      if (!r.ok) throw new Error("Kuru trades unavailable.");
      return (await r.json()) as { through: number; spanSeconds: number; trades: KuruTrade[] };
    } });
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { v: T; text: string; tone?: "bid" | "ask" }[]; onChange: (v: T) => void }) {
  return <div role="radiogroup" aria-label={label} className={cx("grid gap-2", options.length === 2 ? "grid-cols-2" : "grid-cols-3")} onKeyDown={selectionKeys}>
    {options.map((o) => <button key={o.v} type="button" role="radio" aria-checked={value === o.v} tabIndex={value === o.v ? 0 : -1} onClick={() => onChange(o.v)}
      className={cx("ui-toggle h-10 border text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        value === o.v ? o.tone === "bid" ? "border-bid bg-bid text-on-bid" : o.tone === "ask" ? "border-ask bg-ask text-on-ask" : "border-fg bg-fg text-ground"
          : o.tone === "bid" ? "border-bid/60 bg-panel text-bid hover:bg-bid/10" : o.tone === "ask" ? "border-ask/60 bg-panel text-ask hover:bg-ask/10" : "border-line-strong bg-panel text-fg-2 hover:bg-press hover:text-fg")}>{o.text}</button>)}
  </div>;
}

function Field({ id, label, value, onChange, hint, suffix }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: React.ReactNode; suffix?: string }) {
  return <div className="flex flex-col gap-1">
    <label htmlFor={id} className="label text-2xs text-fg-3">{label}</label>
    <div className="flex items-center border border-line-strong bg-ground focus-within:outline-2 focus-within:outline-signal">
      <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.000" className="tnum min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-fg outline-none" />
      {suffix && <span className="px-3 text-xs text-fg-3">{suffix}</span>}
    </div>
    {hint && <span className="text-2xs text-fg-3">{hint}</span>}
  </div>;
}

/** Header stats for the spot pair: no mark, leverage or open interest. */
export function SpotHeader({ manifest, s, trades, now }: { manifest: MarketManifest; s?: SpotSnapshot; trades?: KuruTrade[]; now: number }) {
  const b = nativeBinding(manifest.engine)!;
  const native = useNative(manifest.engine, undefined, s?.block);
  const last = trades?.filter((t) => t.outcome === "yes").at(-1);
  const volume = trades?.reduce((sum, t) => sum + BigInt(t.lots), 0n);
  const quote = (o: Outcome) => s ? `${s.books[o].bids[0] ? tickToPrice(s.books[o].bids[0].tick) : "—"} / ${s.books[o].asks[0] ? tickToPrice(s.books[o].asks[0].tick) : "—"}` : "…";
  return <div className="flex min-h-16 flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
    <div className="flex min-w-0 flex-[1_1_16rem] flex-col items-start gap-1.5">
      <h1 className="w-full break-words text-sm leading-snug font-semibold text-fg">{manifest.title}</h1>
      <Chip tone="signal" className="h-5 px-1.5 text-2xs">Spot · {b.yesSymbol} / {b.noSymbol} on Kuru</Chip>
    </div>
    <p className="shrink-0 text-2xl font-semibold leading-none tnum text-signal" aria-hidden>{last ? tickToPrice(last.tick) : "—"}</p>
    <div className="flex min-w-0 flex-[2_1_28rem] flex-wrap items-center gap-x-7 gap-y-2">
      <Stat label="YES last" tone="signal">{last ? tickToPrice(last.tick) : "—"}</Stat>
      <Stat label="YES bid / ask">{quote("yes")}</Stat>
      <Stat label="NO bid / ask">{quote("no")}</Stat>
      <Stat label="24h volume">{volume !== undefined ? `${lotsText(volume)} tokens` : "—"}</Stat>
      <Stat label="Backed pairs">{native.data ? atomsToUsdc(native.data.outstandingSets) : "—"}</Stat>
      <Stat label={b.scheduledT <= now ? "Event time" : "Event in"}><span className="tnum" title={fmtUtc(b.scheduledT)}>{b.scheduledT <= now ? fmtUtc(b.scheduledT) : fmtDuration(b.scheduledT - now)}</span></Stat>
    </div>
  </div>;
}

/** Kuru L2 ladder for one outcome; clicking a level sets the limit price. */
function KuruBook({ s, error, outcome, onOutcome, onPrice, symbols }: { s?: SpotSnapshot; error?: boolean; outcome: Outcome; onOutcome: (o: Outcome) => void; onPrice: (tick: number) => void; symbols: { yes: string; no: string } }) {
  const l2 = s?.books[outcome];
  const rows = (levels: L2Level[], side: "bid" | "ask") => {
    let total = 0n;
    const withTotals = levels.slice(0, 12).map((l) => ({ ...l, total: (total += l.lots) }));
    const max = withTotals.at(-1)?.total ?? 1n;
    return (side === "ask" ? [...withTotals].reverse() : withTotals).map((l) => <button key={`${side}${l.tick}`} type="button" onClick={() => onPrice(l.tick)}
      className="relative grid w-full grid-cols-3 px-3 py-1 text-left text-xs tnum hover:bg-hover">
      <span aria-hidden className={cx("absolute inset-y-0 right-0", side === "bid" ? "bg-bid/10" : "bg-ask/10")} style={{ width: `${Number(l.total * 100n / max)}%` }} />
      <span className={cx("relative", side === "bid" ? "text-bid" : "text-ask")}>{tickToPrice(l.tick)}</span>
      <span className="relative text-right text-fg">{lotsText(l.lots)}</span>
      <span className="relative text-right text-fg-3">{lotsText(l.total)}</span>
    </button>);
  };
  const spread = l2?.bids[0] && l2?.asks[0] ? l2.asks[0].tick - l2.bids[0].tick : undefined;
  return <section aria-label="Kuru order book" className="flex min-h-0 w-full flex-col">
    <div className="flex items-center justify-between border-b border-line px-3 py-2"><span className="text-xs font-semibold text-fg">Kuru order book</span>
      <div className="flex gap-1">{(["yes", "no"] as const).map((o) => <button key={o} type="button" aria-pressed={outcome === o} onClick={() => onOutcome(o)}
        className={cx("min-h-7 border px-2 text-2xs font-semibold", outcome === o ? "border-fg bg-fg text-ground" : "border-line text-fg-3 hover:text-fg")}>{o.toUpperCase()}</button>)}</div></div>
    <div className="grid grid-cols-3 px-3 py-1.5 text-2xs text-fg-3"><span>Price</span><span className="text-right">{outcome === "yes" ? symbols.yes : symbols.no}</span><span className="text-right">Total</span></div>
    {!l2 ? <p className={cx("p-3 text-xs", error ? "text-ask" : "text-fg-3")}>{error ? "Kuru book unavailable; retrying." : "Reading Kuru…"}</p> : <div className="flex min-h-0 flex-1 flex-col justify-center overflow-auto">
      <div className="flex flex-col justify-end">{l2.asks.length ? rows(l2.asks, "ask") : <p className="px-3 py-2 text-xs text-fg-3">No asks</p>}</div>
      <p className="border-y border-line px-3 py-1.5 text-2xs text-fg-3 tnum">Spread {spread !== undefined ? tickToPrice(spread) : "—"}</p>
      <div>{l2.bids.length ? rows(l2.bids, "bid") : <p className="px-3 py-2 text-xs text-fg-3">No bids</p>}</div>
    </div>}
  </section>;
}

function KuruTradesList({ trades, outcome, isError }: { trades?: KuruTrade[]; outcome: Outcome; isError: boolean }) {
  const list = trades?.filter((t) => t.outcome === outcome).slice(-60).reverse();
  return <section aria-label="Kuru trades" className="flex min-h-0 w-full flex-col">
    <div className="flex items-center justify-between border-b border-line px-3 py-2"><span className="text-xs font-semibold text-fg">Kuru trades</span><span className="text-2xs text-fg-3">{outcome.toUpperCase()}</span></div>
    <div className="grid grid-cols-3 px-3 py-1.5 text-2xs text-fg-3"><span>Price</span><span className="text-right">Tokens</span><span className="text-right">Time</span></div>
    <div className="min-h-0 flex-1 overflow-auto">
      {isError ? <p className="p-3 text-xs text-ask">Trades unavailable.</p> : !list ? <p className="p-3 text-xs text-fg-3">Loading…</p> : list.length === 0 ? <p className="p-3 text-xs text-fg-3">No trades in the last 24h.</p>
        : list.map((t) => <a key={`${t.block}-${t.logIndex}`} href={explorerTx(t.txHash)} target="_blank" rel="noreferrer" className="grid grid-cols-3 px-3 py-1 text-xs tnum hover:bg-hover">
          <span className={t.takerBuy ? "text-bid" : "text-ask"}>{tickToPrice(t.tick)}</span><span className="text-right text-fg">{lotsText(BigInt(t.lots))}</span>
          <span className="text-right text-fg-3">{new Date(t.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></a>)}
    </div>
  </section>;
}

/** Buy/sell (market or post-only limit) and split/merge. */
function SpotTicket({ engine, s, outcome, onOutcome, preset, halted, refetch }: { engine: Address; s?: SpotSnapshot; outcome: Outcome; onOutcome: (o: Outcome) => void; preset?: { tick: number; nonce: number }; halted: boolean; refetch: () => void }) {
  const owner = useOwner();
  const b = nativeBinding(engine)!;
  const tx = useTx();
  const [mode, setMode] = useState<"trade" | "split">("trade");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [slip, setSlip] = useState<number>(100);
  const [setAmt, setSetAmt] = useState("");
  useEffect(() => { if (preset) { setKind("limit"); setMode("trade"); setPrice(tickToPrice(preset.tick)); } }, [preset]);
  useEffect(() => { if (tx.state.status === "done") refetch(); }, [tx.state.status, refetch]);
  const sym = deployment.risk.collateralSymbol;
  const tokenSym = outcome === "yes" ? b.yesSymbol : b.noSymbol;
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const book = outcome === "yes" ? b.yesBook : b.noBook;
  const token = outcome === "yes" ? b.yesToken : b.noToken;
  const l2 = s?.books[outcome];
  const approve = (tokenAddr: Address, spender: Address, atoms: bigint, label: string): Call => ({ address: tokenAddr, abi: erc20ApproveAbi as unknown as Abi, functionName: "approve", args: [spender, atoms], label });
  const run = (calls: Call[]) => owner.address && tx.run(owner.address, calls);

  let error = "", calls: Call[] = [], preview: React.ReactNode = null;
  try {
    if (!s || !l2) throw new Error("");
    if (kind === "market") {
      if (!amount) throw new Error("");
      if (side === "buy") {
        const spend = (parseUsdcToAtoms(amount) / QUOTE_UNIT_ATOMS) * QUOTE_UNIT_ATOMS;
        if (spend === 0n) throw new Error(`Spend at least 0.001 ${sym}.`);
        if (s.wallet && spend > s.wallet.usdc) throw new Error(`Wallet has ${atomsToUsdc(s.wallet.usdc)} ${sym}.`);
        const f = previewBuy(l2.asks, spend, s.takerFeeBps[outcome]);
        if (f.lots === 0n) throw new Error(`No ${tokenSym} for sale on Kuru right now.`);
        const floor = minOut(f.outAtoms, slip);
        preview = <>≈ <b className="text-fg">{claims(f.outAtoms)} {tokenSym}</b> for {atomsToUsdc(f.inAtoms, 3)} {sym} · avg {(Number(f.inAtoms * 1000n / f.outAtoms) / 1000).toFixed(3)}{!f.complete && " · book thinner than your order, the rest is refunded"} · min {claims(floor)}</>;
        calls = [...((s.allowance?.[outcome === "yes" ? "usdcYesBook" : "usdcNoBook"] ?? 0n) < spend ? [approve(b.collateral, book, spend, `approve ${sym}`)] : []),
          { address: book, abi: kuruBookAbi as unknown as Abi, functionName: "placeAndExecuteMarketBuy", args: [spend / QUOTE_UNIT_ATOMS, floor, false, false], label: `buy ${tokenSym}` }];
      } else {
        const lots = parseClaimsToLots(amount);
        if (lots === 0n) throw new Error("Enter at least 0.001 tokens.");
        if (s.wallet && lots * 1000n > s.wallet[outcome]) throw new Error(`Wallet has ${claims(s.wallet[outcome])} ${tokenSym}.`);
        const f = previewSell(l2.bids, lots, s.takerFeeBps[outcome]);
        if (f.lots === 0n) throw new Error(`No buyers for ${tokenSym} on Kuru right now.`);
        const floor = minOut(f.outAtoms, slip);
        preview = <>≈ <b className="text-fg">{atomsToUsdc(f.outAtoms, 3)} {sym}</b> for {claims(f.inAtoms)} {tokenSym}{!f.complete && " · bids cover only part, the rest stays in your wallet"} · min {atomsToUsdc(floor, 3)}</>;
        calls = [...((s.allowance?.[outcome === "yes" ? "yesBook" : "noBook"] ?? 0n) < lots * 1000n ? [approve(token, book, lots * 1000n, `approve ${tokenSym}`)] : []),
          { address: book, abi: kuruBookAbi as unknown as Abi, functionName: "placeAndExecuteMarketSell", args: [lots, floor, false, false], label: `sell ${tokenSym}` }];
      }
    } else {
      if (!amount || !price) throw new Error("");
      const tick = parsePriceToTick(price), lots = parseClaimsToLots(amount);
      if (lots === 0n) throw new Error("Enter at least 0.001 tokens.");
      const bid = l2.bids[0]?.tick, ask = l2.asks[0]?.tick;
      if (side === "buy" && ask !== undefined && tick >= ask) throw new Error(`Limit buys must be below the best ask ${tickToPrice(ask)}. Use Market to buy now.`);
      if (side === "sell" && bid !== undefined && tick <= bid) throw new Error(`Limit sells must be above the best bid ${tickToPrice(bid)}. Use Market to sell now.`);
      const lockToken = side === "buy" ? b.collateral : token;
      const lock = side === "buy" ? bidLockAtoms(tick, lots) : askLockAtoms(lots);
      const inKuru = side === "buy" ? s.margin?.usdc ?? 0n : s.margin?.[outcome] ?? 0n;
      const shortfall = lock > inKuru ? lock - inKuru : 0n;
      const wallet = side === "buy" ? s.wallet?.usdc ?? 0n : s.wallet?.[outcome] ?? 0n;
      if (s.wallet && shortfall > wallet) throw new Error("Not enough in your wallet and Kuru balance.");
      const allowKey = side === "buy" ? "usdcMargin" : outcome === "yes" ? "yesMargin" : "noMargin";
      preview = <>Order rests on Kuru at {tickToPrice(tick)} · {side === "buy" ? `total ${atomsToUsdc(lock, 3)} ${sym}` : `${claims(lock)} ${tokenSym}`}{shortfall > 0n ? " · moves the amount into your Kuru balance first" : ""}</>;
      calls = [
        ...(shortfall > 0n && (s.allowance?.[allowKey] ?? 0n) < shortfall ? [approve(lockToken, KURU_MARGIN, shortfall, "approve Kuru deposit")] : []),
        ...(shortfall > 0n ? [{ address: KURU_MARGIN, abi: kuruMarginAbi as unknown as Abi, functionName: "deposit", args: [owner.address, lockToken, shortfall], label: "deposit to Kuru" }] : []),
        { address: book, abi: kuruBookAbi as unknown as Abi, functionName: side === "buy" ? "addBuyOrder" : "addSellOrder", args: [tick, lots, true], label: `place limit ${side}` },
      ];
    }
  } catch (e) { error = (e as Error).message; calls = []; }

  let setError = "", setAtoms = 0n;
  try { if (setAmt) { setAtoms = parseUsdcToAtoms(setAmt); if (!setAtoms) throw new Error("Enter an amount greater than zero."); } } catch (e) { setError = (e as Error).message; }
  const blocked = !owner.address ? "Log in to trade" : owner.wrongChain ? "Switch to Monad testnet" : !s ? "Reading Kuru…" : "";

  return <section aria-label="Spot order" className="flex flex-col gap-3 p-3">
    <Seg label="Ticket" value={mode} onChange={setMode} options={[{ v: "trade", text: "Buy / sell" }, { v: "split", text: "Mint / redeem pairs" }]} />
    {mode === "trade" ? <>
      <Seg label="Token" value={outcome} onChange={onOutcome} options={[{ v: "yes", text: b.yesSymbol }, { v: "no", text: b.noSymbol }]} />
      <Seg label="Side" value={side} onChange={(v) => { setSide(v); setAmount(""); }} options={[{ v: "buy", text: "Buy", tone: "bid" }, { v: "sell", text: "Sell", tone: "ask" }]} />
      <div className="flex gap-4 text-xs" role="radiogroup" aria-label="Order type" onKeyDown={selectionKeys}>
        {(["market", "limit"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} tabIndex={kind === k ? 0 : -1} onClick={() => setKind(k)}
          className={cx("relative min-h-8 font-semibold", kind === k ? "text-fg" : "text-fg-3 hover:text-fg")}>{k === "market" ? "Market" : "Limit"}{kind === k && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-signal" aria-hidden />}</button>)}
      </div>
      {kind === "limit" && <Field id="spot-price" label="Price" value={price} onChange={setPrice} suffix={sym} />}
      <Field id="spot-amount" label={kind === "market" && side === "buy" ? "Amount to spend" : "Amount"} value={amount} onChange={setAmount}
        suffix={kind === "market" && side === "buy" ? sym : tokenSym}
        hint={s?.wallet && <>Available: {side === "buy" ? `${atomsToUsdc(s.wallet.usdc)} ${sym}` : `${claims(s.wallet[outcome])} ${tokenSym}`}</>} />
      {kind === "market" && <div className="flex items-center justify-between text-2xs text-fg-3"><span>Slippage</span>
        <span className="flex gap-1">{SLIPPAGE.map((v) => <button key={v} type="button" aria-pressed={slip === v} onClick={() => setSlip(v)} className={cx("min-h-7 border px-2", slip === v ? "border-fg text-fg" : "border-line text-fg-3")}>{v / 100}%</button>)}</span></div>}
      {preview && <p className="text-xs leading-relaxed text-fg-2">{preview}</p>}
      {error && <p role="alert" className="text-xs text-ask">{error}</p>}
      {halted && <p className="text-xs text-fg-3">The event has halted: new orders are closed here. Cancel, withdraw and redeem stay available.</p>}
      <Button variant={side === "buy" ? "bid" : "ask"} size="lg" disabled={!!blocked || halted || busy || !calls.length} onClick={() => run(calls)}>
        {blocked || `${side === "buy" ? "Buy" : "Sell"} ${tokenSym}`}
      </Button>
      {calls.length > 1 && <p className="text-2xs text-fg-3">Your wallet will ask for {calls.length} confirmations ({calls.map((c) => c.label).join(", ")}).</p>}
    </> : <>
      <p className="text-xs leading-relaxed text-fg-2">Mint: 1 {sym} → 1 {b.yesSymbol} + 1 {b.noSymbol}. Redeem a pair: 1 of each → 1 {sym}, any time before the outcome. The collateral stays in the vault, so every pair is fully backed.</p>
      <Field id="spot-set" label="Pairs" value={setAmt} onChange={setSetAmt} suffix={sym}
        hint={s?.wallet && <>Wallet: {atomsToUsdc(s.wallet.usdc)} {sym} · {claims(s.wallet.yes)} YES · {claims(s.wallet.no)} NO</>} />
      {setError && <p role="alert" className="text-xs text-ask">{setError}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" disabled={!!blocked || busy || !setAtoms || !s?.issuanceOpen || (!!s?.wallet && setAtoms > s.wallet.usdc)} onClick={() => run([
          ...((s?.allowance?.usdcVault ?? 0n) < setAtoms ? [approve(b.collateral, b.vault, setAtoms, `approve ${sym}`)] : []),
          { address: b.vault, abi: nativeVaultAbi as unknown as Abi, functionName: "split", args: [setAtoms, owner.address], label: "mint YES + NO" }])}>Mint pairs</Button>
        <Button size="lg" disabled={!!blocked || busy || !setAtoms || !!s?.resolved || (!!s?.wallet && (setAtoms > s.wallet.yes || setAtoms > s.wallet.no))} onClick={() => run([
          { address: b.vault, abi: nativeVaultAbi as unknown as Abi, functionName: "merge", args: [setAtoms, owner.address], label: "redeem pairs" }])}>Redeem pairs</Button>
      </div>
      {s && !s.issuanceOpen && <p className="text-xs text-fg-3">Minting is closed (event halted or cap reached); redeeming pairs works until the outcome is final.</p>}
    </>}
    <TxFeedback state={tx.state} />
  </section>;
}

/** Wallet and Kuru balances; withdraw everything held on Kuru. */
function SpotBalances({ engine, s, refetch }: { engine: Address; s?: SpotSnapshot; refetch: () => void }) {
  const owner = useOwner();
  const b = nativeBinding(engine)!;
  const tx = useTx();
  useEffect(() => { if (tx.state.status === "done") refetch(); }, [tx.state.status, refetch]);
  const sym = deployment.risk.collateralSymbol;
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const onKuru = s?.margin ? (["usdc", "yes", "no"] as const).filter((k) => s.margin![k] > 0n) : [];
  return <section aria-label="Balances" className="flex flex-col">
    <div className="border-b border-line px-3 py-2 text-xs font-semibold text-fg">Balances</div>
    {!owner.address ? <p className="p-3 text-xs text-fg-3">Log in to see your balances.</p> : !s?.wallet ? <p className="p-3 text-xs text-fg-3">Reading…</p> : <div className="flex flex-col gap-3 p-3">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1.5 text-xs tnum">
        <span /><span className="text-right text-2xs text-fg-3">Wallet</span><span className="text-right text-2xs text-fg-3">On Kuru</span>
        {([["usdc", sym], ["yes", b.yesSymbol], ["no", b.noSymbol]] as const).map(([k, label]) => <span key={k} className="contents">
          <span className="text-fg-2">{label}</span>
          <span className="text-right text-fg">{k === "usdc" ? atomsToUsdc(s.wallet![k]) : claims(s.wallet![k])}</span>
          <span className="text-right text-fg">{k === "usdc" ? atomsToUsdc(s.margin![k]) : claims(s.margin![k])}</span>
        </span>)}
      </div>
      <Button size="md" disabled={busy || owner.wrongChain || !onKuru.length} onClick={() => owner.address && tx.run(owner.address, onKuru.map((k) => ({
        address: KURU_MARGIN, abi: kuruMarginAbi as unknown as Abi, functionName: "withdraw",
        args: [s.margin![k], k === "usdc" ? b.collateral : k === "yes" ? b.yesToken : b.noToken], label: `withdraw ${k === "usdc" ? sym : k.toUpperCase()} from Kuru` })))}>Move Kuru balance to wallet</Button>
      <p className="text-2xs leading-relaxed text-fg-3">Limit orders and their fills sit on Kuru; market orders settle straight to your wallet. Amounts locked in open orders free up when you cancel.</p>
      <TxFeedback state={tx.state} />
    </div>}
  </section>;
}

function SpotActivity({ engine, s, trades, refetch }: { engine: Address; s?: SpotSnapshot; trades?: KuruTrade[]; refetch: () => void }) {
  const owner = useOwner();
  const b = nativeBinding(engine)!;
  const tx = useTx();
  const id = useId();
  const [tab, setTab] = useState<"orders" | "fills">("orders");
  useEffect(() => { if (tx.state.status === "done") refetch(); }, [tx.state.status, refetch]);
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const me = owner.address?.toLowerCase();
  const mine = useMemo(() => me ? (trades ?? []).filter((t) => t.maker.toLowerCase() === me || t.taker.toLowerCase() === me).slice().reverse() : [], [trades, me]);
  const cancel = (groups: { o: Outcome; ids: number[] }[]) => owner.address && tx.run(owner.address, groups.filter((g) => g.ids.length)
    .map((g) => ({ address: g.o === "yes" ? b.yesBook : b.noBook, abi: kuruBookAbi as unknown as Abi, functionName: "batchCancelOrders", args: [g.ids], label: `cancel ${g.o.toUpperCase()} orders` })));
  return <section aria-label="Your Kuru activity" className="flex flex-col">
    <div className="flex border-b border-line" role="tablist" onKeyDown={selectionKeys}>
      {(["orders", "fills"] as const).map((t, i) => <button key={t} role="tab" id={`${id}-${i}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)}
        className={cx("relative min-h-11 px-3 text-xs", tab === t ? "text-fg" : "text-fg-3 hover:text-fg")}>{t === "orders" ? `Open orders${s?.orders?.length ? ` (${s.orders.length})` : ""}` : "My trades"}{tab === t && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-signal" aria-hidden />}</button>)}
      {tab === "orders" && !!s?.orders?.length && <button className="ml-auto px-3 text-xs text-signal-text underline disabled:text-fg-4" disabled={busy}
        onClick={() => cancel((["yes", "no"] as const).map((o) => ({ o, ids: s.orders!.filter((x) => x.outcome === o).map((x) => x.id) })))}>Cancel all</button>}
    </div>
    <div role="tabpanel" className="max-h-72 overflow-auto p-3">
      {!owner.address ? <p className="text-xs text-fg-3">Log in to see your orders and trades.</p>
        : tab === "orders" ? (!s?.orders ? <p className="text-xs text-fg-3">Reading…</p> : s.orders.length === 0 ? <p className="text-xs text-fg-3">No open orders.</p>
          : <table className="w-full text-xs tnum"><thead><tr className="text-left text-2xs text-fg-3"><th className="py-1 font-medium">Token</th><th className="font-medium">Side</th><th className="text-right font-medium">Price</th><th className="text-right font-medium">Amount</th><th /></tr></thead>
            <tbody>{s.orders.map((o) => <tr key={`${o.outcome}${o.id}`} className="hair-b"><td className="py-1.5">{o.outcome === "yes" ? b.yesSymbol : b.noSymbol}</td>
              <td className={o.isBuy ? "text-bid" : "text-ask"}>{o.isBuy ? "Buy" : "Sell"}</td><td className="text-right">{tickToPrice(o.tick)}</td><td className="text-right">{lotsText(o.lots)}</td>
              <td className="text-right"><button className="text-fg-3 underline hover:text-fg disabled:text-fg-4" disabled={busy} onClick={() => cancel([{ o: o.outcome, ids: [o.id] }])}>Cancel</button></td></tr>)}</tbody></table>)
        : mine.length === 0 ? <p className="text-xs text-fg-3">No trades in the last 24h.</p>
          : <table className="w-full text-xs tnum"><thead><tr className="text-left text-2xs text-fg-3"><th className="py-1 font-medium">Time</th><th className="font-medium">Token</th><th className="font-medium">Side</th><th className="text-right font-medium">Price</th><th className="text-right font-medium">Amount</th></tr></thead>
            <tbody>{mine.map((t) => { const buy = t.taker.toLowerCase() === me ? t.takerBuy : !t.takerBuy; return <tr key={`${t.block}${t.logIndex}`} className="hair-b">
              <td className="py-1.5"><a className="inline-flex items-center gap-1 underline decoration-line-strong" href={explorerTx(t.txHash)} target="_blank" rel="noreferrer">{new Date(t.timestamp * 1000).toLocaleTimeString()}<ExternalLink size={10} aria-hidden /></a></td>
              <td>{t.outcome === "yes" ? b.yesSymbol : b.noSymbol}</td><td className={buy ? "text-bid" : "text-ask"}>{buy ? "Buy" : "Sell"}</td><td className="text-right">{tickToPrice(t.tick)}</td><td className="text-right">{lotsText(BigInt(t.lots))}</td></tr>; })}</tbody></table>}
      <TxFeedback state={tx.state} />
    </div>
  </section>;
}

/** The spot workspace: Kuru book, YES price chart, trades, ticket, balances and activity. */
export function SpotWorkspace({ manifest, halted, spot, trades, live }: { manifest: MarketManifest; halted: boolean; spot: ReturnType<typeof useSpot>; trades: ReturnType<typeof useKuruTrades>; live: ReturnType<typeof usePriceSeries> }) {
  const b = nativeBinding(manifest.engine)!;
  const [outcome, setOutcome] = useState<Outcome>("yes");
  const [preset, setPreset] = useState<{ tick: number; nonce: number }>();
  const s = spot.data;
  const refetch = spot.refetch as unknown as () => void;
  const yesMid = s?.books.yes.bids[0] && s.books.yes.asks[0] ? (s.books.yes.bids[0].tick + s.books.yes.asks[0].tick) / 2000 : undefined;
  return <div className={styles.workspace}>
    <div className={styles.chart}>
      <PriceAxis index={live.index} perp={[]} indexUnit={yesMid} emptyTitle="Waiting for price" emptyReason="The YES price is published from the Kuru book every minute."
        historyStatus={live.historyStatus} readError={!!live.error} source={`${b.yesSymbol} on Kuru`} />
    </div>
    <aside className={styles.trade} aria-label="Spot order">
      <SpotTicket engine={manifest.engine} s={s} outcome={outcome} onOutcome={setOutcome} preset={preset} halted={halted} refetch={refetch} />
    </aside>
    <div className={styles.trades}><KuruTradesList trades={trades.data?.trades} outcome={outcome} isError={trades.isError} /></div>
    <div className={styles.account}><SpotBalances engine={manifest.engine} s={s} refetch={refetch} /></div>
    <div className={styles.book}><KuruBook s={s} error={spot.isError} outcome={outcome} onOutcome={setOutcome} onPrice={(tick) => setPreset({ tick, nonce: Date.now() })} symbols={{ yes: b.yesSymbol, no: b.noSymbol }} /></div>
    <section className={styles.activity}><SpotActivity engine={manifest.engine} s={s} trades={trades.data?.trades} refetch={refetch} /></section>
  </div>;
}

/** "Trade this event as": perp on Eros, or the YES/NO tokens on Kuru. */
export function VenueBar({ s, engine, venue, onChange }: { s?: SpotSnapshot; engine: Address; venue: "perp" | "spot"; onChange: (v: "perp" | "spot") => void }) {
  const b = nativeBinding(engine)!;
  const q = (o: Outcome) => s ? `${s.books[o].bids[0] ? tickToPrice(s.books[o].bids[0].tick) : "—"} / ${s.books[o].asks[0] ? tickToPrice(s.books[o].asks[0].tick) : "—"}` : "…";
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-x border-b border-line bg-panel px-3 py-2 text-xs">
    <span className="text-fg-2">Trade this event as</span>
    <div role="tablist" aria-label="Trading venue" className="flex gap-2" onKeyDown={selectionKeys}>
      {(["perp", "spot"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={venue === v} tabIndex={venue === v ? 0 : -1} onClick={() => onChange(v)}
        className={cx("min-h-9 border px-3 font-semibold", venue === v ? "border-signal bg-signal text-on-signal" : "border-line-strong bg-ground text-fg hover:bg-hover")}>
        {v === "perp" ? "Perp on Eros (long / short)" : "YES/NO tokens on Kuru (spot)"}
      </button>)}
    </div>
    <span className="tnum text-fg-3">Kuru {b.yesSymbol} {q("yes")} · {b.noSymbol} {q("no")}</span>
  </div>;
}

export { useKuruTrades };
