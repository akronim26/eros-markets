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
import { orderPreviewCurrent, orderPreviewOptions } from "@/lib/order-preview";
import { canonicalTrade, displayTickForOutcome, type TradeIntent } from "@/lib/trade-view";
import { useMaxOrder } from "@/lib/use-max-order";
import { OrderSummary } from "./order-summary";
import { qToMoney } from "@/lib/units";
import { REJECT, ORDER_KIND } from "@/lib/enums";
import { useTx, summarizeOrder } from "@/lib/tx";
import { lotsToClaims, parseClaimsToLots, parsePriceToTick } from "@/lib/units";
import { FieldError, useFieldErrors, ReadError } from "./feedback";
import { TxFeedback } from "./tx-feedback";
import { Check } from "lucide-react";
import { useLoginAction, useOwner } from "./wallet";
import { useSwitchChain } from "wagmi";
import { chain } from "@/config/chain";
import { marketByEngine } from "@/config/deployment";
import { Button, RegionHead, Row, cx, selectionKeys } from "./ui";

import type { BookPriceIntent } from "./order-book";

type Parsed = { ok: true; tick: number; lots: bigint } | { ok: false; error: string };
const TRADE_CHOICES: TradeIntent[] = [
  { outcome: "YES", direction: "long" }, { outcome: "YES", direction: "short" },
  { outcome: "NO", direction: "long" }, { outcome: "NO", direction: "short" },
];
const intentLabel = (intent: TradeIntent) => `${intent.direction === "long" ? "Long" : "Short"} ${intent.outcome}`;

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function Ticket({ engine, market, trader, intent, bookPrice, readUnavailable = false }: { engine: Address; market?: MarketSnapshot; trader?: TraderSnapshot; intent?: CloseIntent; bookPrice?: BookPriceIntent; readUnavailable?: boolean }) {
  const archived = marketByEngine(engine)?.archived ?? false;
  const owner = useOwner();
  const loginAction = useLoginAction();
  const { switchChain, error: chainError } = useSwitchChain();
  const [tradeIntent, setTradeIntent] = useState<TradeIntent>(TRADE_CHOICES[0]);
  const side = canonicalTrade(tradeIntent, 500).side;
  const [kind, setKind] = useState(0);
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [inputRevision, setInputRevision] = useState(0);
  const [reduceOnlyChoice, setReduceOnly] = useState(false);
  const reduceOnly = archived || reduceOnlyChoice;
  const tx = useTx();
  const permissions = usePermissions(owner.address);
  const delegated = permissions.data?.modes.find((p) => p.mode === "trade" && p.granted && p.engines.includes(engine.toLowerCase()));
  const [oneClick, setOneClick] = useState(false);
  const [expiry, setExpiry] = useState("");
  useEffect(() => { if (intent) { setTradeIntent({ outcome: "YES", direction: intent.side === "buy" ? "long" : "short" }); setSize(intent.size); setPrice(intent.price); setReduceOnly(true); setKind(1); setExpiry(""); setTargetLeverage(undefined); setInputRevision((n) => n + 1); } }, [intent]);
  // A book click carries a YES price. Convert once when that new click arrives.
  useEffect(() => { if (bookPrice) { setPrice((displayTickForOutcome(tradeIntent.outcome, bookPrice.tick) / 1000).toFixed(3)); setTargetLeverage(undefined); setInputRevision((n) => n + 1); } }, [bookPrice]);
  let expires = 0, expiryError = "";
  try { expires = expiryBlock(expiry, market?.block ?? 0n); } catch (e) { expiryError = (e as Error).message; }
  const cap = market?.leverageCaps[side === "buy" ? "long" : "short"];
  const bestTick = (side === "buy" ? market?.bestAsk : market?.bestBid) ?? 0;
  const [targetLeverage, setTargetLeverage] = useState<number>();
  useEffect(() => { setTargetLeverage(undefined); }, [cap]);
  // For a flat account equity equals cash even before a normal mark exists.
  const sizingEquity = trader?.account?.preview.cashQ ?? 0n;
  const reservedOrders = !!trader?.account && (trader.account.preview.orders.bidLots > 0n || trader.account.preview.orders.askLots > 0n);
  const canSizeLeverage = !!trader?.account && trader.account.preview.positionLots === 0n && !reservedOrders && !reduceOnly && sizingEquity > 0n;
  useEffect(() => { setTargetLeverage(undefined); }, [engine, owner.address, sizingEquity, reservedOrders]);


  const parsed = useMemo((): Parsed => {
    try {
      const tick = canonicalTrade(tradeIntent, parsePriceToTick(price)).tick;
      const lots = parseClaimsToLots(size);
      if (lots === 0n) return { ok: false, error: "Enter a size" };
      return { ok: true, tick, lots };
    } catch (e) {
      return { ok: false, error: price && size ? (e as Error).message : "" };
    }
  }, [price, size, tradeIntent]);

  const fieldErrors = { price: "", size: "", expiry: expiryError };
  try { parsePriceToTick(price); } catch { fieldErrors.price = "Enter a price from 0.001 to 0.999 (up to 3 decimals)."; }
  try { if (parseClaimsToLots(size) === 0n) fieldErrors.size = "Enter at least 0.001 claims."; } catch { fieldErrors.size = "Enter a positive claim size with up to 3 decimals."; }
  const validation = useFieldErrors(fieldErrors);

  const traderId = trader?.traderId ?? 0;
  const dParsed = useDebounced(parsed);
  const previewQuery = useQuery({
    ...orderPreviewOptions(engine, owner.address, traderId, side, dParsed.ok ? dParsed.tick : 1, dParsed.ok ? dParsed.lots : 1n, reduceOnly, market?.block ?? 0n),
    enabled: traderId > 0 && dParsed.ok && !!market && trader?.block === market.block && !readUnavailable,
  });
  const sameIntent = parsed.ok && dParsed.ok && parsed.tick === dParsed.tick && parsed.lots === dParsed.lots;
  const preview = { ...previewQuery, data: sameIntent && !readUnavailable && orderPreviewCurrent(previewQuery.data, market, trader) ? previewQuery.data?.value : undefined };

  let priceTick: number | undefined;
  try { priceTick = canonicalTrade(tradeIntent, parsePriceToTick(price)).tick; } catch { /* Incomplete input. */ }
  const maximum = useMaxOrder({ engine, owner: owner.address, market, trader, tick: priceTick,
    isBuy: side === "buy", reduceOnly, unavailable: readUnavailable, inputRevision });

  function chooseIntent(next: TradeIntent) {
    if (next.outcome !== tradeIntent.outcome) {
      try { setPrice((displayTickForOutcome(next.outcome, canonicalTrade(tradeIntent, parsePriceToTick(price)).tick) / 1000).toFixed(3)); }
      catch { setPrice(""); }
    }
    setTradeIntent(next);
    setTargetLeverage(undefined);
  }

  // The state that keeps the order from being sent, in the order the user meets it. Disabled
  // labels name a state; actions the user can take (log in, switch network) stay enabled.
  const blocker = tx.recovery ? "Recover previous request first"
    : archived && !trader?.account?.preview.positionLots ? "Archived · no position to reduce"
    : readUnavailable ? "Live reads unavailable"
    : !market
    ? "Loading market"
    : market.halted
      ? "Market halted"
      : !market.active
        ? "Opens on activation"
        : traderId === 0
          ? "Not funded yet"
          : trader?.block !== market.block ? "Refreshing account…"
              : !parsed.ok
                ? parsed.error || "Enter price and size"
                : expiryError ? expiryError
                : preview.isError ? "Order preview unavailable"
                : !preview.data || !dParsed.ok || parsed.tick !== dParsed.tick || parsed.lots !== dParsed.lots ? "Checking order…"
                : preview.data.rejection !== 0
                  ? REJECT[preview.data.rejection] || "Order cannot be admitted"
                  : preview.data.acceptedCapLots < parsed.lots ? "Reduce size to the admissible limit"
                  : null;

  async function submit() {
    if (!owner.address || !market || !parsed.ok || blocker || owner.wrongChain) return;
    await tx.run(
      owner.address,
      [
        {
          ...ownerTrader(engine, owner.address).placeOrder({ kind, isBuy: side === "buy", reduceOnly, tick: parsed.tick, size: parsed.lots, maxFills: market.maxFills, expiryBlock: expires }),
          label: "order",
          validate: async (blockNumber) => {
            const id = await client.readContract({ address: engine, abi: engineAbi, functionName: "participantId", args: [owner.address!], blockNumber });
            const fresh = await client.readContract({ address: engine, abi: engineAbi, functionName: "previewOrder", args: [id, side === "buy" ? 0 : 1, parsed.tick, parsed.lots, reduceOnly], blockNumber });
            if (expires && BigInt(expires) <= blockNumber) throw new Error("The order expiry has passed. Choose a later block.");
            if (fresh.rejection || fresh.acceptedCapLots < parsed.lots) throw new Error(REJECT[fresh.rejection] || "The latest preview does not admit this exact size. Refresh and review the order.");
          },
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
      <div className="flex flex-col gap-3 p-3">
        {archived && <p className="text-xs text-fg-3">This market accepts position reductions only in this interface.</p>}
        <div className="grid grid-cols-2 gap-px" role="group" aria-label="Trade direction and outcome">
          {TRADE_CHOICES.map((choice) => (
            <button
              key={intentLabel(choice)}
              type="button"
              aria-pressed={tradeIntent.outcome === choice.outcome && tradeIntent.direction === choice.direction}
              onClick={() => chooseIntent(choice)}
              className={cx(
                "h-8 text-xs font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-signal",
                tradeIntent.outcome === choice.outcome && tradeIntent.direction === choice.direction
                  ? choice.direction === "long"
                    ? "bg-bid text-on-bid"
                    : "bg-ask text-on-ask"
                  : "text-fg-3 shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:text-fg",
              )}
            >
              {intentLabel(choice)}
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

        <label htmlFor={validation.props("price").id} className="flex flex-col gap-1.5">
          <span className="label flex justify-between text-fg-3">
            <span>{tradeIntent.outcome} price</span>
            {bestTick > 0 && (
              <button type="button" className="text-fg-2 hover:text-fg" onClick={() => { setPrice((displayTickForOutcome(tradeIntent.outcome, bestTick) / 1000).toFixed(3)); setTargetLeverage(undefined); }}>
                Use best {tradeIntent.direction === "long" ? "ask" : "bid"}
              </button>
            )}
          </span>
          <input className={field} inputMode="decimal" placeholder="0.000" value={price} {...validation.props("price")} onChange={(e) => { setPrice(e.target.value); setTargetLeverage(undefined); }} />
          <FieldError id={validation.errorId("price")}>{validation.message("price")}</FieldError>
        </label>

        <label htmlFor={validation.props("size").id} className="flex flex-col gap-1.5">
          <span className="label flex justify-between text-fg-3">
            <span>Size (claims)</span>
            <button type="button" disabled={!maximum.enabled || maximum.busy} title="Search available order capacity at this price" className="text-fg-2 hover:text-fg disabled:opacity-40" onClick={() => { void maximum.search((lots) => { setSize(lotsToClaims(lots)); setTargetLeverage(undefined); }); }}>
              {maximum.busy ? "Finding Max…" : "Max"}
            </button>
          </span>
          <input className={field} inputMode="decimal" placeholder="0.000" value={size} {...validation.props("size")} onChange={(e) => { setSize(e.target.value); setTargetLeverage(undefined); setInputRevision((n) => n + 1); }} />
          <FieldError id={validation.errorId("size")}>{validation.message("size")}</FieldError>
        </label>
        {maximum.message && <p role="status" className="text-xs leading-relaxed text-fg-3">{maximum.message}</p>}
        {maximum.error && <p role="alert" className="text-xs leading-relaxed text-ask">{maximum.error}</p>}

        <div className="grid gap-1.5">
          <p className="label flex justify-between text-fg-3"><span>Target leverage</span><span>{cap === undefined ? "Reading limit…" : `Current limit ${cap}×`}</span></p>
          <div className="grid grid-cols-5 gap-1" role="group" aria-label="Target leverage">
            {[1, 2, 3, 4, 5].map((x) => <button key={x} type="button" aria-pressed={targetLeverage === x}
              disabled={!canSizeLeverage || cap === undefined || BigInt(x) > cap || (x > 1 && !market?.risk.markAvailable) || !!fieldErrors.price || readUnavailable || trader?.block !== market?.block}
              className={cx("h-7 border text-xs tnum transition-colors disabled:cursor-not-allowed disabled:opacity-35", targetLeverage === x ? "border-signal bg-signal/10 text-signal-text" : "border-line-strong text-fg-2 hover:bg-press")}
              onClick={() => { try { const lots = leverageLots(sizingEquity, canonicalTrade(tradeIntent, parsePriceToTick(price)).tick, side === "buy", x, market?.risk.markAvailable ? market.risk.markWad : undefined); setSize(lotsToClaims(lots)); setTargetLeverage(x); setInputRevision((n) => n + 1); } catch { setTargetLeverage(undefined); } }}>{x}×</button>)}
          </div>
          <details className="text-xs text-fg-3">
            <summary className="cursor-pointer py-1 hover:text-fg">Trading details</summary>
            <div className="grid gap-2 pb-1 pt-2 leading-relaxed">
              <p>Long YES = Short NO. Short YES = Long NO. All choices net into one position; an opposite trade can close it.</p>
              {market?.active && !market.halted && cap !== undefined && cap < market.listing.deploymentCapX && <p className="border-l-2 border-signal/60 pl-2 text-fg-2">{market.risk.pricingMode === 0 ? "Bootstrap: 1× until the price windows are ready and an hourly epoch opens." : !market.risk.indexAvailable || !market.risk.markAvailable ? "Higher leverage is temporarily unavailable while the price windows recover." : "The current risk or reserve limit is below the deployment cap."}</p>}
              <p>{reservedOrders ? "Cancel open orders before sizing by leverage." : reduceOnly ? "Leverage sizing is for new positions. Turn off Reduce only to size a new position." : !canSizeLeverage ? "Fund this market and start from a flat position to size by leverage." : fieldErrors.price ? "Enter a valid order price or use the best price, then choose your leverage." : "Sizes against the live mark and accounts for the spread. The order preview checks margin and fees."} Limits adjust with price readiness and risk.</p>
            </div>
          </details>
        </div>

        <label className="label flex items-center gap-2 text-fg-2">
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={reduceOnly}
              disabled={archived}
              onChange={(e) => { setReduceOnly(e.target.checked); setTargetLeverage(undefined); }}
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

        <OrderSummary engine={engine} owner={owner.address} market={market} trader={trader} tradeIntent={tradeIntent}
          order={parsed.ok ? { tick: parsed.tick, lots: parsed.lots, isBuy: side === "buy", reduceOnly } : undefined}
          feeCapQ={preview.data?.rejection === 0 ? preview.data.feeCapQ : undefined} admittedLots={preview.data?.acceptedCapLots} unavailable={readUnavailable} />

        {delegated && <label className="flex items-start gap-2 text-xs text-fg-2"><input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} />Use Privy one-click trading for this order</label>}
        {tx.recovery && <div className="border border-line p-3 text-xs text-fg-2">
          <p>A previous one-click request still needs confirmation. Recover it before starting another order.</p>
          <p className="mt-2 break-all">Wallet: {tx.recovery.body.wallet}</p>
          <p className="mt-2 break-all">Market: {tx.recovery.body.engine}</p>
          {tx.recovery.body.action === "placeOrder" && <p className="mt-1">{tx.recovery.body.place.isBuy ? "Buy YES" : "Sell YES"} · {lotsToClaims(BigInt(tx.recovery.body.place.size))} claims at YES {(tx.recovery.body.place.tick / 1000).toFixed(3)}</p>}
          <Button className="mt-2" disabled={owner.wrongChain || tx.state.status === "pending" || tx.state.status === "sent"} onClick={() => owner.address && tx.recover(owner.address)}>Recover previous request</Button>
        </div>}
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
            {blocker ?? (tx.state.status === "pending" || tx.state.status === "sent" ? tx.state.step : intentLabel(tradeIntent))}
          </Button>
        )}

        {preview.isError && <ReadError message="Order preview unavailable. Check your connection and retry." retry={() => { void preview.refetch(); }} />}
        {owner.wrongChain && chainError && <p role="alert" className="text-xs text-ask">Network switch was not completed. Unlock your wallet and try again.</p>}
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
