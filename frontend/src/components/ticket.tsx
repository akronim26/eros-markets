"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client, type MarketSnapshot, type TraderSnapshot } from "@/lib/reads";
import { usePermissions } from "@/lib/privy-api";
import { expiryBlock, type CloseIntent } from "@/lib/trade-intent";
import { ownerTrader } from "@/lib/trader";
import { leverageLots } from "@/lib/leverage";
import { qToMoney } from "@/lib/units";
import { REJECT, ORDER_KIND } from "@/lib/enums";
import { useTx, summarizeOrder } from "@/lib/tx";
import { atomsToUsdc, buyBackedAtoms, lotsToClaims, parseClaimsToLots, parsePriceToTick, sellBackedAtoms } from "@/lib/units";
import { FieldError, useFieldErrors, ReadError } from "./feedback";
import { TxFeedback } from "./tx-feedback";
import { Check } from "lucide-react";
import { useLoginAction, useOwner } from "./wallet";
import { useSwitchChain } from "wagmi";
import { chain } from "@/config/chain";
import { Button, RegionHead, Row, cx, selectionKeys } from "./ui";

type Side = "buy" | "sell";
type Parsed = { ok: true; tick: number; lots: bigint } | { ok: false; error: string };

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function Ticket({ engine, market, trader, intent }: { engine: Address; market?: MarketSnapshot; trader?: TraderSnapshot; intent?: CloseIntent }) {
  const owner = useOwner();
  const loginAction = useLoginAction();
  const { switchChain } = useSwitchChain();
  const [side, setSide] = useState<Side>("buy");
  const [kind, setKind] = useState(0);
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const tx = useTx();
  const permissions = usePermissions(owner.address);
  const delegated = permissions.data?.modes.find((p) => p.mode === "trade" && p.granted && p.engines.includes(engine.toLowerCase()));
  const [oneClick, setOneClick] = useState(false);
  const [expiry, setExpiry] = useState("");
  useEffect(() => { if (intent) { setSide(intent.side); setSize(intent.size); setPrice(intent.price); setReduceOnly(true); setKind(1); } }, [intent]);
  let expires = 0, expiryError = "";
  try { expires = expiryBlock(expiry, market?.block ?? 0n); } catch (e) { expiryError = (e as Error).message; }
  const cap = market?.leverageCaps[side === "buy" ? "long" : "short"];
  const [targetLeverage, setTargetLeverage] = useState<number>();
  useEffect(() => { setTargetLeverage(undefined); }, [cap]);
  const canSizeLeverage = !!trader?.account && trader.account.preview.positionLots === 0n && !reduceOnly && trader.account.preview.markEquityQ > 0n;


  const parsed = useMemo((): Parsed => {
    try {
      const tick = parsePriceToTick(price);
      const lots = parseClaimsToLots(size);
      if (lots === 0n) return { ok: false, error: "Enter a size" };
      return { ok: true, tick, lots };
    } catch (e) {
      return { ok: false, error: price && size ? (e as Error).message : "" };
    }
  }, [price, size]);

  const fieldErrors = { price: "", size: "", expiry: expiryError };
  try { parsePriceToTick(price); } catch { fieldErrors.price = "Enter a price from 0.001 to 0.999 (up to 3 decimals)."; }
  try { if (parseClaimsToLots(size) === 0n) fieldErrors.size = "Enter at least 0.001 claims."; } catch { fieldErrors.size = "Enter a positive claim size with up to 3 decimals."; }
  const validation = useFieldErrors(fieldErrors);

  const traderId = trader?.traderId ?? 0;
  const dParsed = useDebounced(parsed);
  const preview = useQuery({
    queryKey: ["previewOrder", engine, traderId, side, dParsed.ok ? dParsed.tick : 0, dParsed.ok ? dParsed.lots.toString() : "", reduceOnly, market?.block.toString()],
    enabled: traderId > 0 && dParsed.ok && !!market,
    queryFn: () =>
      client.readContract({
        address: engine,
        abi: engineAbi,
        functionName: "previewOrder",
        args: dParsed.ok ? [traderId, side === "buy" ? 0 : 1, dParsed.tick, dParsed.lots, reduceOnly] : [0, 0, 1, 1n, false],
        blockNumber: market?.block,
      }),
  });

  const cost = parsed.ok ? (side === "buy" ? buyBackedAtoms(parsed.lots, parsed.tick) : sellBackedAtoms(parsed.lots, parsed.tick)) : undefined;
  const payout = parsed.ok ? parsed.lots * 1000n : undefined; // atoms if the side wins, per lot 1,000 atoms

  // The state that keeps the order from being sent, in the order the user meets it. Disabled
  // labels name a state; actions the user can take (log in, switch network) stay enabled.
  const blocker = !market
    ? "Loading market"
    : market.halted
      ? "Market halted"
      : !market.active
        ? "Opens on activation"
        : traderId === 0
          ? "Not funded yet"
              : !parsed.ok
                ? parsed.error || "Enter price and size"
                : expiryError ? expiryError
                : preview.isError ? "Order preview unavailable"
                : !preview.data || !dParsed.ok || parsed.tick !== dParsed.tick || parsed.lots !== dParsed.lots ? "Checking order…"
                : preview.data.rejection !== 0
                  ? REJECT[preview.data.rejection]
                  : null;

  async function submit() {
    if (!owner.address || !market || !parsed.ok || blocker || owner.wrongChain) return;
    await tx.run(
      owner.address,
      [
        {
          ...ownerTrader(engine, owner.address).placeOrder({ kind, isBuy: side === "buy", reduceOnly, tick: parsed.tick, size: parsed.lots, maxFills: market.maxFills, expiryBlock: expires }),
          label: "order",
        },
      ],
      summarizeOrder,
      oneClick && delegated ? { previewBlock: market.block } : undefined,
    );
  }

  const field = "h-9 w-full bg-ground px-3 text-sm tnum text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)] placeholder:text-fg-4 focus:shadow-[inset_0_0_0_2px_var(--color-signal)] focus:outline-none";

  return (
    <section aria-label="Order ticket" className="flex h-full flex-col">
      <RegionHead title="Order" />
      <div className="flex flex-col gap-4 p-3">
        <div className="grid grid-cols-2" role="group" aria-label="Side">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={side === s}
              onClick={() => { setSide(s); setTargetLeverage(undefined); }}
              className={cx(
                "h-9 text-sm font-semibold transition-colors duration-150",
                side === s
                  ? s === "buy"
                    ? "bg-bid text-on-bid"
                    : "bg-ask text-on-ask"
                  : "text-fg-3 shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-fg",
              )}
            >
              {s === "buy" ? "Buy YES" : "Sell YES"}
            </button>
          ))}
        </div>

        <div className="flex gap-px bg-line" role="radiogroup" aria-label="Order type" onKeyDown={selectionKeys}>
          {ORDER_KIND.map((k, i) => (
            <button
              key={k}
              role="radio"
              aria-checked={kind === i}
              tabIndex={kind === i ? 0 : -1}
              onClick={() => setKind(i)}
              className={cx("label h-7 flex-1", kind === i ? "bg-press text-fg" : "bg-ground text-fg-3 hover:text-fg")}
            >
              {k}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="label flex justify-between text-fg-3">
            <span>Price (probability)</span>
            {market && market.bestBid + market.bestAsk > 0 && (
              <button className="text-fg-2 hover:text-fg" onClick={() => setPrice(`0.${String(side === "buy" ? market.bestAsk || market.bestBid : market.bestBid || market.bestAsk).padStart(3, "0")}`)}>
                Use best {side === "buy" ? "ask" : "bid"}
              </button>
            )}
          </span>
          <input className={field} inputMode="decimal" placeholder="0.000" value={price} {...validation.props("price")} onChange={(e) => { setPrice(e.target.value); setTargetLeverage(undefined); }} />
          <FieldError id={validation.errorId("price")}>{validation.message("price")}</FieldError>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="label flex justify-between text-fg-3">
            <span>Size (claims)</span>
            {preview.data && preview.data.acceptedCapLots > 0n && (
              <button className="text-fg-2 hover:text-fg" onClick={() => { setSize(lotsToClaims(preview.data!.acceptedCapLots)); setTargetLeverage(undefined); }}>
                Max {lotsToClaims(preview.data.acceptedCapLots)}
              </button>
            )}
          </span>
          <input className={field} inputMode="decimal" placeholder="0.000" value={size} {...validation.props("size")} onChange={(e) => { setSize(e.target.value); setTargetLeverage(undefined); }} />
          <FieldError id={validation.errorId("size")}>{validation.message("size")}</FieldError>
        </label>

        <div className="grid gap-2">
          <p className="label flex justify-between text-fg-3"><span>Target leverage</span><span>{cap === undefined ? "Reading limit…" : `Current limit ${cap}×`}</span></p>
          <div className="grid grid-cols-5 gap-1" role="group" aria-label="Target leverage">
            {[1, 2, 3, 4, 5].map((x) => <button key={x} type="button" aria-pressed={targetLeverage === x}
              disabled={!canSizeLeverage || cap === undefined || BigInt(x) > cap || !price}
              className={cx("h-9 border text-sm tnum transition-colors disabled:cursor-not-allowed disabled:opacity-35", targetLeverage === x ? "border-signal bg-signal/10 text-signal-text" : "border-line-strong text-fg-2 hover:bg-press")}
              onClick={() => { try { const lots = leverageLots(trader!.account!.preview.markEquityQ, parsePriceToTick(price), side === "buy", x); setSize(lotsToClaims(lots)); setTargetLeverage(x); } catch { setTargetLeverage(undefined); } }}>{x}×</button>)}
          </div>
          <p className="text-xs leading-relaxed text-fg-3">{!canSizeLeverage ? "Fund this market and start from a flat position to size by leverage." : "Sizes a new position using market equity. Fees, fills and risk checks determine actual leverage."} Limits adjust with price readiness and risk.</p>
        </div>

        <label className="label flex items-center gap-2 text-fg-2">
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={reduceOnly}
              onChange={(e) => setReduceOnly(e.target.checked)}
              className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none border border-line-strong bg-ground checked:bg-action"
            />
            <Check size={11} strokeWidth={3} className="pointer-events-none relative hidden text-on-action peer-checked:block" aria-hidden />
          </span>
          Reduce only
        </label>

        <details className="text-xs text-fg-2">
          <summary className="label cursor-pointer">Advanced order</summary>
          <label className="mt-3 flex flex-col gap-1.5">Expires at block (optional)<input className={field} inputMode="numeric" placeholder="Good until cancelled" value={expiry} {...validation.props("expiry")} onChange={(e) => setExpiry(e.target.value)} /><FieldError id={validation.errorId("expiry")}>{validation.message("expiry")}</FieldError></label>
          {preview.data && <dl className="mt-2"><Row k="Required initial margin" v={preview.data.fullBackingRequired ? "Fully backed" : qToMoney(preview.data.requiredImQ).usdc} /><Row k="Equity after reservations" v={preview.data.id.markAvailable ? qToMoney(preview.data.eMinQ).usdc : "No mark"} /><Row k="Deficit if NO / YES" v={`${qToMoney(preview.data.d0AfterQ).usdc} / ${qToMoney(preview.data.d1AfterQ).usdc}`} /><Row k="Reserve coverage" v={preview.data.marketCoverageAfter ? "Covered" : "Unavailable"} /></dl>}
        </details>

        <dl className="hair-b -mx-3 border-t border-line px-3 py-1">
          <Row k="Full-backing amount" v={cost !== undefined ? `${atomsToUsdc(cost, 2)}` : "—"} hint="Buy = size × price; sell = size × (1 − price). Initial margin can be lower when leverage is available; fees are separate." />
          <Row k={side === "buy" ? "Gross payoff if YES" : "Gross payoff if NO"} v={payout !== undefined ? atomsToUsdc(payout, 2) : "—"} />
          <Row k="Fee reserved" v={preview.data ? atomsToUsdc(preview.data.feeCapQ / 10n ** 18n, 6) : "—"} />
          <Row k="Max admissible" v={preview.data ? `${lotsToClaims(preview.data.acceptedCapLots)} claims` : traderId === 0 ? "fund to preview" : "—"} />
        </dl>

        {delegated && <label className="flex items-start gap-2 text-xs text-fg-2"><input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} />Use Privy one-click trading for this order</label>}
        {!owner.connected ? (
          <Button variant="primary" size="lg" arrow disabled={!loginAction.ready} onClick={() => loginAction.login()}>
            Log in to trade
          </Button>
        ) : owner.wrongChain ? (
          <Button variant="secondary" size="lg" onClick={() => switchChain({ chainId: chain.id })}>
            Switch to Monad testnet
          </Button>
        ) : (
          <Button variant={side === "buy" ? "bid" : "ask"} size="lg" arrow disabled={!!blocker || tx.state.status === "pending" || tx.state.status === "sent"} onClick={submit}>
            {blocker ?? (tx.state.status === "pending" || tx.state.status === "sent" ? tx.state.step : `${side === "buy" ? "Buy" : "Sell"} YES`)}
          </Button>
        )}

        {preview.isError && <ReadError message="Order preview unavailable. Check your connection and retry." retry={() => { void preview.refetch(); }} />}
        {preview.data && preview.data.rejection !== 0 && parsed.ok && <p role="status" className="text-xs leading-relaxed text-ask">{REJECT[preview.data.rejection] || "This order cannot be admitted. Review your price, size, and collateral."}</p>}
        <TxFeedback state={tx.state} />
        {!market?.active && market && (
          <p className="text-xs leading-relaxed text-fg-3">
            Orders open once governance activates this market and the signed index feed is running.
          </p>
        )}
      </div>
    </section>
  );
}
