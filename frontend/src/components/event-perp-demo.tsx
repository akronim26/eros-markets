"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check, Plus, RotateCcw } from "lucide-react";
import { cx } from "./ui";
import styles from "./event-perp-demo.module.css";

type Side = "long" | "short";
type Outcome = "YES" | "NO" | null;
const DEFAULT_ENTRY = 60;
const DEFAULT_CLAIMS = 100;
const DEFAULT_ODDS = 80;
const format = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${format(Math.abs(n))}`;
const pricePnl = (odds: number, side: Side, entry: number, claims: number) => ((odds - entry) * claims / 100) * (side === "long" ? 1 : -1);

/** Price P&L across event probabilities. The highlighted segment connects entry to the selected price. */
function PayoffChart({ side, odds, entry, claims }: { side: Side; odds: number; entry: number; claims: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(280);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([measurement]) => setWidth(Math.max(220, Math.round(measurement.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const height = 220;
  const extent = Math.max(entry, 100 - entry) * claims / 100;
  const limit = extent * 1.18;
  const x = (p: number) => 46 + p / 100 * (width - 64);
  const y = (pnl: number) => 20 + (limit - pnl) / (2 * limit) * (height - 56);
  const pnl = pricePnl(odds, side, entry, claims);
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`${side} price P&L at ${odds}%: ${signed(pnl)} test units. Entry ${entry}%.`}>
        {[-extent, 0, extent].map((value) => (
          <g key={value}>
            <line x1={x(0)} x2={x(100)} y1={y(value)} y2={y(value)} stroke="var(--color-ivory)" strokeOpacity={value === 0 ? 0.3 : 0.1} />
            <text x={x(0) - 8} y={y(value) + 4} textAnchor="end" fontSize={10} fill="var(--color-ivory-3)">{signed(value)}</text>
          </g>
        ))}
        {[0, 50, 100].map((p) => <text key={p} x={x(p)} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--color-ivory-3)">{p}%</text>)}
        <line x1={x(entry)} x2={x(entry)} y1={20} y2={height - 30} stroke="var(--color-ivory-3)" strokeDasharray="2 5" strokeOpacity={0.45} />
        <text x={x(entry)} y={10} textAnchor={entry < 25 ? "start" : entry > 75 ? "end" : "middle"} fontSize={10} fill="var(--color-ivory-3)">ENTRY {entry}%</text>
        <path d={`M ${x(0)} ${y(pricePnl(0, side, entry, claims))} L ${x(100)} ${y(pricePnl(100, side, entry, claims))}`} stroke="var(--color-ivory)" strokeOpacity={0.35} strokeWidth={1.5} fill="none" />
        <path d={`M ${x(entry)} ${y(0)} L ${x(odds)} ${y(pnl)} L ${x(odds)} ${y(0)} Z`} fill="var(--color-signal)" fillOpacity={0.16} />
        <line x1={x(entry)} x2={x(odds)} y1={y(0)} y2={y(pnl)} stroke="var(--color-signal)" strokeWidth={3} />
        <line x1={x(odds)} x2={x(odds)} y1={y(pnl)} y2={height - 30} stroke="var(--color-signal)" strokeOpacity={0.5} strokeDasharray="2 5" />
        <rect x={x(entry) - 3} y={y(0) - 3} width={6} height={6} fill="var(--color-ivory)" />
        <rect x={x(odds) - 9} y={y(pnl) - 9} width={18} height={18} fill="var(--color-ink)" stroke="var(--color-signal)" strokeOpacity={0.5} />
        <rect x={x(odds) - 4} y={y(pnl) - 4} width={8} height={8} fill="var(--color-signal)" />
      </svg>
    </div>
  );
}

function TradeSettings({ id, entry, claims, leverage, onEntry, onClaims, onLeverage }: {
  id: string; entry: number; claims: number; leverage: number;
  onEntry: (value: number) => void; onClaims: (value: number) => void; onLeverage: (value: number) => void;
}) {
  return (
    <div className="mt-6 space-y-5">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${id}-entry`} className="label text-fg-3">Entry probability</label><span className="tnum text-xl text-fg" aria-hidden>{entry}<span className="ml-1 text-xs text-fg-3">%</span></span>
        </div>
        <input id={`${id}-entry`} data-demo-input="entry" type="range" min={1} max={99} step={1} value={entry} onChange={(event) => onEntry(Number(event.target.value))}
          aria-valuetext={`${entry}%, entry price ${(entry / 100).toFixed(2)}`} className={styles.slider} />
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={`${id}-claims`} className="label text-fg-3">Position size</label><span className="tnum text-xl text-fg" aria-hidden>{format(claims)}<span className="ml-2 text-xs text-fg-3">claims</span></span>
        </div>
        <input id={`${id}-claims`} data-demo-input="claims" type="range" min={10} max={1000} step={10} value={claims} onChange={(event) => onClaims(Number(event.target.value))}
          aria-valuetext={`${claims} claims`} className={styles.slider} />
      </div>
      <fieldset>
        <legend className="label mb-3 text-fg-3">Leverage <span className="text-fg-4">/ simulated</span></legend>
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 5].map((value) => (
            <button key={value} type="button" data-demo-leverage={value} aria-pressed={leverage === value} onClick={() => onLeverage(value)}
              className={cx("frame flex min-h-11 items-center justify-center gap-1 text-sm", leverage === value ? "bg-action text-on-action hover:bg-action-hover" : "text-fg hover:bg-hover")}>
              {value}x {leverage === value && <Check size={12} aria-hidden />}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function EventPerpDemo() {
  const id = useId();
  const [side, setSide] = useState<Side>("long");
  const [entry, setEntry] = useState(DEFAULT_ENTRY);
  const [claims, setClaims] = useState(DEFAULT_CLAIMS);
  const [leverage, setLeverage] = useState(1);
  const [odds, setOdds] = useState(DEFAULT_ODDS);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const pnl = pricePnl(odds, side, entry, claims);
  // Directional backing divided by leverage; not the risk engine's margin quote.
  const collateral = claims * (side === "long" ? entry : 100 - entry) / 100 / leverage;
  const priceReturn = pnl / collateral * 100;
  const beyondCollateral = pnl <= -collateral && leverage > 1;
  const moveOdds = (value: number) => { setOdds(value); setOutcome(null); };
  const settle = (value: Exclude<Outcome, null>) => { setOutcome(value); setOdds(value === "YES" ? 100 : 0); };
  const reset = () => { setSide("long"); setEntry(DEFAULT_ENTRY); setClaims(DEFAULT_CLAIMS); setLeverage(1); moveOdds(DEFAULT_ODDS); };

  return (
    <div className="frame mt-7 bg-panel">
      <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className={cx(styles.stage, "min-w-0 bg-ink p-5 text-ivory sm:p-7")}>
          <p className="label flex items-center gap-2 text-ivory-3"><span className="h-1.5 w-1.5 bg-signal" aria-hidden />Example market / Macro</p>
          <h3 className="mt-3 max-w-[30ch] text-lg leading-snug font-medium sm:text-xl">Will the next rate decision be a cut?</h3>
          <div className="mt-7 flex flex-wrap items-end justify-between gap-3" role="status" aria-live="polite" aria-atomic="true" data-demo-result>
            <div>
              <p className="label text-ivory-3">{outcome ? `${outcome} outcome / ` : ""}Position P&amp;L</p>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
                <span className={cx("pixel tnum text-[clamp(2.75rem,5vw,5rem)] leading-none", pnl < 0 ? "text-signal" : "text-ivory")} data-demo-pnl>{signed(pnl)}</span>
                <span className="text-xs text-ivory-3">test units</span>
              </div>
            </div>
            <div className="pb-1 text-left sm:text-right">
              <p className="label text-ivory-3">Price return</p>
              <span className="tnum mt-1 block text-lg text-signal" data-demo-return>{signed(priceReturn)}%</span>
            </div>
            {beyondCollateral && <p className="w-full text-xs text-ivory-3">Price loss exceeds demo collateral. See model limits below.</p>}
          </div>
          <div className="mt-5"><PayoffChart side={side} odds={odds} entry={entry} claims={claims} /></div>
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${id}-odds`} className="text-sm text-ivory">Move the odds <span className="text-ivory-3" aria-hidden>→</span></label>
              <span className="tnum text-2xl text-signal" aria-hidden>{odds}%</span>
            </div>
            <input id={`${id}-odds`} data-demo-input="odds" type="range" min={0} max={100} step={1} value={odds} onChange={(event) => moveOdds(Number(event.target.value))}
              aria-valuetext={`${odds}% chance of YES, event price ${(odds / 100).toFixed(2)}`} className={cx(styles.slider, styles.darkSlider)} />
            <div className="flex flex-wrap items-center justify-between gap-x-4">
              <span className="label text-ivory-3">Try an outcome</span>
              <div className="flex gap-2">
                {(["NO", "YES"] as const).map((value) => (
                  <button key={value} type="button" aria-label={`Resolves ${value}`} aria-pressed={outcome === value} onClick={() => settle(value)}
                    className={cx("label inline-flex min-h-11 items-center gap-2 px-3", outcome === value ? "bg-signal text-ink" : "text-ivory shadow-[inset_0_0_0_1px_var(--color-ivory-3)] hover:bg-ink-2")}>
                    {value}<span aria-hidden>↗</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col p-5 sm:p-7">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="label text-fg-3">Your position</p>
            <button type="button" onClick={reset} aria-label="Reset example" title="Reset example" className="flex h-11 w-11 items-center justify-center text-fg-3 hover:bg-hover hover:text-fg"><RotateCcw size={16} aria-hidden /></button>
          </div>
          <fieldset>
            <legend className="sr-only">Choose your direction</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["long", "short"] as const).map((value) => {
                const Icon = value === "long" ? ArrowUpRight : ArrowDownRight;
                return (
                  <label key={value} className="cursor-pointer">
                    <input type="radio" name={`${id}-side`} value={value} checked={side === value} onChange={() => setSide(value)} className="peer sr-only" />
                    <span className="frame flex flex-col gap-1 p-3 text-fg peer-checked:bg-action peer-checked:text-on-action peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal hover:bg-hover">
                      <span className="flex items-center justify-between gap-2 font-semibold"><span className="capitalize">{value}</span><Icon size={16} className="text-signal" aria-hidden /></span>
                      <span className="flex items-center justify-between gap-1 text-xs"><span>Odds {value === "long" ? "rise" : "fall"}</span>{side === value && <Check size={12} aria-hidden />}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <TradeSettings id={id} entry={entry} claims={claims} leverage={leverage} onEntry={setEntry} onClaims={setClaims} onLeverage={setLeverage} />
          <div className="mt-6 flex items-baseline justify-between gap-2 text-sm lg:hidden" aria-hidden>
            <span className="label text-fg-3">Position P&amp;L</span><span className="tnum text-xl">{signed(pnl)} <span className="text-xs text-fg-3">units</span></span>
          </div>
          <dl className="mt-auto flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-5 max-lg:mt-6">
            <dt className="label text-fg-3">Demo collateral</dt>
            <dd className="tnum text-2xl text-fg" data-demo-collateral>{format(collateral)} <span className="text-xs text-fg-3">units</span></dd>
          </dl>
        </div>
      </div>
      <details className="group border-t border-line-strong">
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4 text-xs text-fg-3 hover:bg-hover sm:px-7 [&::-webkit-details-marker]:hidden">
          <span>Practice only · Testnet trading is 1x</span>
          <span className="inline-flex items-center gap-2 text-fg">About this demo <Plus size={14} className="group-open:rotate-45" aria-hidden /></span>
        </summary>
        <div className="max-w-[95ch] space-y-3 px-5 pb-5 text-xs leading-relaxed text-fg-3 sm:px-7">
          <p>This example uses invented prices. Leverage above 1x is hypothetical. Fees, funding, liquidations, and reserve protection are omitted; displayed price P&amp;L is not a predicted account payout.</p>
          <p>Price P&amp;L = claims × price change (reversed for shorts). Demo collateral = claims × entry price ÷ leverage for longs, or claims × (1 − entry price) ÷ leverage for shorts. Price return = P&amp;L ÷ collateral. Leverage changes collateral at a fixed position size; actual required margin may be higher.</p>
          <p>Real trades require matching orders. Open positions settle after trading halts, the outcome is final, and payouts are prepared.</p>
        </div>
      </details>
    </div>
  );
}
