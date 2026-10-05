"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Minus } from "lucide-react";
import { useHead, useMarket } from "@/lib/reads";
import { markets } from "@/config/deployment";
import { PRICING, STAGE } from "@/lib/enums";
import { fmtDuration, fmtUtc, lotsToClaims, shortAddr } from "@/lib/units";
import { Num, SectionRule, cx } from "./ui";

const ENGINE = markets[0].engine;
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ interactions */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/";

/** Scramble-text: characters resolve left to right on mount and on hover. */
function Scramble({ text, className }: { text: string; className?: string }) {
  const [out, setOut] = useState(text);
  const raf = useRef(0);
  const run = () => {
    if (reduced()) return;
    cancelAnimationFrame(raf.current);
    const start = performance.now();
    const dur = 650;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const settled = Math.floor(p * text.length);
      setOut(
        Array.from(text)
          .map((ch, i) => (i < settled || ch === " " || ch === "." ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
          .join(""),
      );
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    run();
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <span className={className} onMouseEnter={run} aria-label={text}>
      <span aria-hidden>{out}</span>
    </span>
  );
}

/** Types lines out once, character by character, then keeps a blinking caret on the last line. */
function useTyped(lines: string[], ready: boolean) {
  const [n, setN] = useState(0);
  const total = useMemo(() => lines.reduce((s, l) => s + l.length + 1, 0), [lines]);
  useEffect(() => {
    if (!ready) return;
    if (reduced()) return setN(total);
    const id = setInterval(() => setN((x) => (x >= total ? x : x + 2)), 16);
    return () => clearInterval(id);
  }, [ready, total]);
  let left = n;
  return lines.map((l) => {
    const take = Math.max(0, Math.min(l.length, left));
    left -= l.length + 1;
    return l.slice(0, take);
  });
}

/** Wall clock in seconds, offset to chain time when known, ticking every second. */
function useClock(chainNow?: bigint) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return chainNow ?? BigInt(now);
}

/* ------------------------------------------------------------------ hero */

const LEFT = ["Question", "Probability", "Position"];
const RIGHT = ["Halt", "Resolve", "Claim"];

/** The market lifecycle converging on the mark: question → price → position, then halt → resolve → claim. */
function NodeDiagram() {
  return (
    <div className="relative mx-auto my-8 h-[150px] w-full max-w-[640px]" aria-label="Market lifecycle: question, probability and position flow into the market; it halts, resolves and pays claims">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 640 150" preserveAspectRatio="none" aria-hidden>
        {[25, 75, 125].map((y, i) => (
          <g key={y}>
            <line x1={150} y1={y} x2={278} y2={75} stroke="var(--color-line)" />
            <line x1={362} y1={75} x2={490} y2={y} stroke="var(--color-line)" />
            <rect x={146} y={y - 3} width={6} height={6} fill="var(--color-signal)">
              {!reduced() && <animate attributeName="opacity" values="1;0.25;1" dur="2.4s" begin={`${i * 0.4}s`} repeatCount="indefinite" />}
            </rect>
            <rect x={488} y={y - 3} width={6} height={6} fill="var(--color-ink)" />
          </g>
        ))}
      </svg>
      {LEFT.map((t, i) => (
        <span key={t} className="label frame absolute left-0 flex h-6 w-[136px] items-center justify-center bg-ground text-fg" style={{ top: 13 + i * 50 }}>
          {t}
        </span>
      ))}
      {RIGHT.map((t, i) => (
        <span key={t} className="label frame absolute right-0 flex h-6 w-[136px] items-center justify-center bg-ground text-fg" style={{ top: 13 + i * 50 }}>
          {t}
        </span>
      ))}
      <div className="frame absolute top-1/2 left-1/2 flex h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 items-center justify-center bg-panel max-sm:h-16 max-sm:w-16">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/eros-markets-mark-on-light.svg" alt="" className="h-12 w-12 max-sm:h-9 max-sm:w-9" />
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="px-4 pt-10 pb-20 text-center md:pt-14">
      <h1 className="sr-only">Price. Trade. Resolve.</h1>
      <p className="pixel text-[clamp(2.75rem,8vw,6rem)] leading-[0.95] text-fg" aria-hidden>
        <Scramble text="PRICE. TRADE." />
      </p>
      <NodeDiagram />
      <p className="pixel text-[clamp(2.75rem,8vw,6rem)] leading-[0.95] text-fg" aria-hidden>
        <Scramble text="RESOLVE." />
      </p>
      <p className="mx-auto mt-8 max-w-[56ch] text-sm leading-relaxed text-fg-2">
        Eros Markets turns a YES/NO question into a perpetual you can trade. A fully on-chain order book on Monad, an
        isolated reserve for every market, and a three-layer oracle that decides the outcome.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href={`/m/${ENGINE}`} className="group inline-flex h-10 items-stretch">
          <span className="flex w-10 items-center justify-center bg-signal text-on-signal" aria-hidden>
            <ArrowRight size={15} strokeWidth={2} />
          </span>
          <span className="label flex items-center bg-ink px-5 text-ivory group-hover:bg-ink-2">Open the terminal</span>
        </Link>
        <Link href="#resolution" className="label frame inline-flex h-10 items-center px-5 text-fg hover:bg-hover">
          How it resolves
        </Link>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ live market bento */

function PanelHead({ left, right, dark }: { left: string; right?: React.ReactNode; dark?: boolean }) {
  return (
    <div className={cx("label flex h-8 items-center justify-between px-3", dark ? "text-ivory-3 shadow-[inset_0_-1px_0_#2a2a2c]" : "text-fg-3 shadow-[inset_0_-1px_0_var(--color-ink)]")}>
      <span>{left}</span>
      {right}
    </div>
  );
}

/** The Eros mark rendered as a dot matrix: the depth ladder, with the Signal bar as the mark price. */
function MarkDither() {
  const bars = [
    { y: 0, w: 76 },
    { y: 11, w: 64 },
    { y: 22, w: 22 },
    { y: 47, w: 22 },
    { y: 58, w: 64 },
    { y: 69, w: 76 },
  ];
  const cell = 2.25;
  const dots: { x: number; y: number; s: boolean; d: number }[] = [];
  const add = (x0: number, y0: number, w: number, h: number, s: boolean) => {
    for (let y = y0; y < y0 + h; y += cell)
      for (let x = x0; x < x0 + w; x += cell) dots.push({ x, y, s, d: (x * 7 + y * 13) % 100 });
  };
  bars.forEach((b) => add(0, b.y, b.w, 7, false));
  add(0, 33.5, 50, 9, true);
  return (
    <svg viewBox="-3 -3 82 82" className="h-full w-full" role="img" aria-label="The Eros Markets mark drawn as a dot matrix depth ladder">
      {dots.map((d, i) => (
        <rect key={i} x={d.x} y={d.y} width={cell * 0.62} height={cell * 0.62} fill={d.s ? "var(--color-signal)" : "var(--color-ink)"} opacity={d.s ? 1 : 0.35 + (d.d % 50) / 80}>
          {!reduced() && d.s && <animate attributeName="opacity" values="1;0.4;1" dur="3s" begin={`${(d.d % 30) / 10}s`} repeatCount="indefinite" />}
        </rect>
      ))}
    </svg>
  );
}

const DEADLINES = [
  { off: 45_000n, label: "Final-day grace" },
  { off: 43_200n, label: "Backing floor" },
  { off: 3_600n, label: "Reduce only" },
  { off: 0n, label: "Scheduled halt" },
];

function LiveMarket() {
  const head = useHead();
  const m = useMarket(ENGINE, head.data?.number).data;
  const now = useClock(head.data ? head.data.timestamp + BigInt(Math.floor((Date.now() - head.data.at) / 1000)) : undefined);

  const T = m?.listing.scheduledT;
  const next = T !== undefined ? DEADLINES.find((d) => T - d.off > now) : undefined;
  const lines = useMemo(() => {
    if (!m || !head.data) return [] as string[];
    return [
      `> connect monad-testnet  chain=10143`,
      `> read engine ${shortAddr(ENGINE)}  block=${head.data.number}`,
      `> stage=${STAGE[m.risk.stage].toLowerCase().replace(/ /g, "_")}  pricing=${PRICING[m.risk.pricingMode].toLowerCase().replace(/ /g, "_")}`,
      `> index ${m.risk.indexAvailable ? "live" : "unavailable: no signed window yet"}`,
      `> mark ${m.risk.markAvailable ? "live" : "unavailable: bootstrap"}`,
      `> book bid=${m.bestBid ? (m.bestBid / 1000).toFixed(3) : "none"} ask=${m.bestAsk ? (m.bestAsk / 1000).toFixed(3) : "none"}`,
      `> traders ${m.participants}/${m.listing.maxTraders}  oi=${lotsToClaims(m.oiLots)} claims`,
      m.active ? `> market active` : `> awaiting activation`,
    ];
  }, [m, head.data]);
  const typed = useTyped(lines, lines.length > 0);
  const life = T !== undefined && m ? Number(((now - m.listing.listedAt) * 1000n) / (T - m.listing.listedAt)) / 10 : 0;

  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="LIVE_MARKET" index={1} />
      <div className="frame mt-6 grid grid-cols-1 bg-ground md:grid-cols-2">
        {/* terminal */}
        <div className="flex min-h-[300px] flex-col bg-ink md:shadow-[inset_-1px_0_0_var(--color-ink)]">
          <PanelHead dark left="TERMINAL.SYS" right={<span className="flex gap-1.5" aria-hidden><span className="h-2 w-2 bg-signal" /><span className="h-2 w-2 bg-ivory" /><span className="h-2 w-2 shadow-[inset_0_0_0_1px_var(--color-ivory)]" /></span>} />
          <pre className="flex-1 overflow-x-auto p-4 text-xs leading-6 text-ivory-3" aria-live="polite">
            {lines.length === 0 ? (
              <span className="caret">{"> connecting to monad testnet"}</span>
            ) : (
              typed.map((l, i) => (
                <div key={i} className={cx(i === typed.length - 1 && "caret text-ivory", l.length === 0 && "hidden")}>
                  {l}
                </div>
              ))
            )}
          </pre>
        </div>
        {/* mark */}
        <div className="flex min-h-[300px] flex-col shadow-[inset_0_1px_0_var(--color-ink)] md:shadow-none">
          <PanelHead left="MARK.DITHER" right={<span className="tnum">76×76</span>} />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="aspect-square w-full max-w-[420px]">
              <MarkDither />
            </div>
          </div>
        </div>
        {/* metrics */}
        <div className="flex flex-col shadow-[inset_0_1px_0_var(--color-ink)] md:shadow-[inset_0_1px_0_var(--color-ink),inset_-1px_0_0_var(--color-ink)]">
          <PanelHead left="MARKET.METRICS" right={<span className="h-2 w-2 bg-signal" aria-hidden />} />
          <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-6 p-6 sm:grid-cols-2">
            {[
              ["Block", head.data ? head.data.number.toLocaleString("en-US") : "—"],
              ["Traders", m ? `${m.participants} / ${m.listing.maxTraders}` : "—"],
              ["Open interest", m ? `${lotsToClaims(m.oiLots)}` : "—"],
              ["To halt", T !== undefined ? (T > now ? fmtDuration(T - now) : "passed") : "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dd className="text-2xl font-medium tracking-[-0.02em] text-fg sm:text-3xl">
                  <Num value={v} />
                </dd>
                <dt className="label mt-1 text-fg-3">{k}</dt>
              </div>
            ))}
          </dl>
        </div>
        {/* lifecycle */}
        <div className="flex flex-col shadow-[inset_0_1px_0_var(--color-ink)]">
          <PanelHead left="LIFECYCLE.STATUS" right={<span className="tnum">{m ? (m.active ? "ACTIVE" : "INACTIVE") : "…"}</span>} />
          <table className="w-full text-left">
            <thead>
              <tr className="label text-fg-3">
                <th className="px-4 pt-3 pb-2 font-normal">Stage</th>
                <th className="px-4 pt-3 pb-2 font-normal">Status</th>
                <th className="px-4 pt-3 pb-2 text-right font-normal">At (UTC)</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              {DEADLINES.map((d) => {
                const at = T !== undefined ? T - d.off : undefined;
                const passed = at !== undefined && at <= now;
                const isNext = next?.label === d.label;
                return (
                  <tr key={d.label} className="hair-b">
                    <td className="px-4 py-2.5 text-fg">{d.label}</td>
                    <td className="px-4 py-2.5">
                      <span className="label inline-flex items-center gap-2 text-fg-2">
                        <span className={cx("h-2 w-2", isNext ? "bg-signal" : passed ? "bg-fg-4" : "shadow-[inset_0_0_0_1px_var(--color-ink)]")} aria-hidden />
                        {isNext ? "Next" : passed ? "Passed" : "Upcoming"}
                      </span>
                    </td>
                    <td className="tnum px-4 py-2.5 text-right text-fg-2">{at !== undefined ? fmtUtc(at).replace(" UTC", "") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-auto p-4">
            <div className="label flex justify-between text-fg-3">
              <span>Market lifetime elapsed</span>
              <span className="tnum">{life.toFixed(1)}%</span>
            </div>
            <div className="frame mt-2 h-2.5 p-px">
              <div className="h-full bg-ink" style={{ width: `${Math.min(100, Math.max(0, life))}%` }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ mechanism */

/** Spec worked example: Alice long 1,000 claims at 0.60 with 120 USDC; Bob short with 100. Value vs outcome price. */
function PayoffFigure() {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(520);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const H = Math.round(W * 0.7);
  const fs = 11;
  const L = 44;
  const px = (q: number) => L + q * (W - L - 12);
  const py = (v: number) => 30 + ((720 - v) / 1240) * (H - 76); // value range −520 .. 720
  const tag = (x: number, y: number, text: string, fill: string, anchor: "start" | "end" = "start") => {
    const w = text.length * fs * 0.62 + 8;
    const x0 = anchor === "end" ? x - w : x;
    return (
      <g>
        <rect x={x0} y={y - fs} width={w} height={fs + 5} fill="var(--color-panel)" />
        <text x={x0 + 4} y={y} fontSize={fs} fill={fill}>{text}</text>
      </g>
    );
  };
  return (
    <div ref={ref} className="h-full w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Equity of a 5x long and a 4x short across outcome prices; deficits below zero are covered by the reserve">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-signal)" strokeWidth="1.5" />
          </pattern>
        </defs>
        <text x={4} y={14} fontSize={fs} fill="var(--color-fg-3)">EQUITY (USDC)</text>
        {[-400, -200, 0, 200, 400, 600].map((v) => (
          <g key={v}>
            <line x1={px(0)} x2={px(1)} y1={py(v)} y2={py(v)} stroke={v === 0 ? "var(--color-ink)" : "var(--color-line)"} />
            <text x={px(0) - 6} y={py(v) + 4} textAnchor="end" fontSize={fs} fill="var(--color-fg-4)" className="tnum">{v}</text>
          </g>
        ))}
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((q) => (
          <text key={q} x={px(q)} y={H - 28} textAnchor="middle" fontSize={fs} fill="var(--color-fg-4)" className="tnum">{q.toFixed(1)}</text>
        ))}
        <polygon points={`${px(0)},${py(0)} ${px(0)},${py(-480)} ${px(0.48)},${py(0)}`} fill="url(#hatch)" />
        <polygon points={`${px(0.7)},${py(0)} ${px(1)},${py(-300)} ${px(1)},${py(0)}`} fill="url(#hatch)" />
        <line x1={px(0)} y1={py(-480)} x2={px(1)} y2={py(520)} stroke="var(--color-ink)" strokeWidth={2} />
        <line x1={px(0)} y1={py(700)} x2={px(1)} y2={py(-300)} stroke="var(--color-fg-3)" strokeWidth={2} strokeDasharray="5 4" />
        <line x1={px(0.6)} x2={px(0.6)} y1={py(720)} y2={py(-520)} stroke="var(--color-signal)" strokeWidth={2} />
        {tag(px(0.6) + 6, py(-470), "MARK 0.60", "var(--color-signal-text)")}
        {tag(px(1) - 2, py(520) - 10, W < 480 ? "LONG 5x" : "LONG 5x: 520 IF YES", "var(--color-ink)", "end")}
        {tag(px(0.08), py(620), W < 480 ? "SHORT 4x" : "SHORT 4x: 700 IF NO", "var(--color-fg-3)")}
        {tag(px(0.02), py(-60), "RESERVE COVERS", "var(--color-signal-text)")}
        <text x={px(0)} y={H - 8} fontSize={fs} fill="var(--color-fg-3)">OUTCOME PRICE</text>
      </svg>
    </div>
  );
}

function Mechanism() {
  const head = useHead();
  const m = useMarket(ENGINE, head.data?.number).data;
  const now = useClock(head.data ? head.data.timestamp + BigInt(Math.floor((Date.now() - head.data.at) / 1000)) : undefined);
  const T = m?.listing.scheduledT;
  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="MECHANISM" index={2} />
      <div className="frame mt-6 grid grid-cols-1 bg-ground lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col bg-panel lg:shadow-[inset_-1px_0_0_var(--color-ink)]">
          <PanelHead left="RENDER: PAYOFF.SVG" right={<span className="text-signal-text">SPEC EXAMPLE</span>} />
          <div className="flex-1 p-4">
            <PayoffFigure />
          </div>
          <div className="label flex justify-between px-3 py-2 text-fg-3 shadow-[inset_0_1px_0_var(--color-ink)]">
            <span>Fixture: 5x leverage, not enabled on testnet</span>
            <span>Source: risk spec §5</span>
          </div>
        </div>
        <div className="flex flex-col shadow-[inset_0_1px_0_var(--color-ink)] lg:shadow-none">
          <PanelHead left="MANIFEST.MD" right={<span className="tnum">v1.1</span>} />
          <div className="flex flex-1 flex-col gap-5 p-6">
            <h2 className="text-2xl leading-tight font-semibold tracking-[-0.02em] text-fg uppercase">
              Markets built for
              <br />
              <span className="text-signal-text">event probability</span>
            </h2>
            <p className="text-sm leading-relaxed text-fg-2">
              Every price is a probability on a 0.001 grid. Buy a claim and it pays 1 if the outcome is YES. The order book,
              margin and settlement all run on chain, inside one isolated contract per market.
            </p>
            <p className="text-sm leading-relaxed text-fg-2">
              Leverage is backed by the market&apos;s own reserve: losses beyond your collateral are covered, never owed, and
              you pay an insurance premium for that cover. Payouts open only after the contract has prepared every claim.
            </p>
            <div className="label flex items-center gap-2 py-3 text-fg-2 shadow-[inset_0_1px_0_var(--color-ink),inset_0_-1px_0_var(--color-ink)]">
              <span className="h-2 w-2 bg-signal" aria-hidden />
              Market clock:
              <span className="tnum text-signal-text">{T !== undefined ? (T > now ? `T − ${fmtDuration(T - now)}` : "halted") : "…"}</span>
            </div>
            <dl className="grid grid-cols-2">
              {[
                ["Tick", "0.001"],
                ["Lot", "0.001 claim"],
                ["Max traders", "1,024"],
                ["Payout / claim", "1 USDC"],
              ].map(([k, v], i) => (
                <div key={k} className={cx("frame p-3", i % 2 === 1 && "-ml-px", i > 1 && "-mt-px")}>
                  <dt className="label text-fg-3">{k}</dt>
                  <dd className="mt-1 text-lg font-medium text-fg">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ resolution layers */

const LAYERS = [
  {
    id: "LAYER_01",
    title: "Data feed",
    sub: "Chainlink CRE reads the listed source after the market halts.",
    yes: ["Reads the pinned source at T", "Proposes YES or NO with a value hash", "Bonded assertion, open to dispute"],
    no: ["Decides questions without a feed"],
  },
  {
    id: "LAYER_02",
    title: "Panel + committee",
    sub: "Three model families judge a public evidence snapshot; humans sign.",
    yes: ["Evidence pinned to IPFS by hash", "2-of-3 committee signs the proposal", "Injection flags route to human review"],
    no: ["Auto-proposes before validation"],
    dark: true,
  },
  {
    id: "LAYER_03",
    title: "Disputes",
    sub: "Any proposal can be disputed with a bond before it becomes final.",
    yes: ["Optimistic oracle settles disputes", "Void deadline guarantees a final outcome", "INVALID pays the captured price"],
    no: ["Pays out before claims are prepared"],
  },
];

function Resolution() {
  return (
    <section id="resolution" className="mx-auto max-w-[1280px] scroll-mt-28 px-4 pb-24 md:px-8">
      <SectionRule name="RESOLUTION" index={3} />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Three layers decide the outcome</h2>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-fg-2">
            A market halts at its scheduled time. The outcome is then proposed, open to challenge, and only final when no
            dispute stands.
          </p>
        </div>
        <span className="label flex items-center gap-2 text-fg-3">
          <span className="h-2 w-2 bg-signal" aria-hidden />
          Every halted market reaches a final outcome
        </span>
      </div>
      <div className="frame mt-6 grid grid-cols-1 md:grid-cols-3">
        {LAYERS.map((l, i) => (
          <div
            key={l.id}
            className={cx(
              "flex flex-col",
              l.dark ? "bg-ink text-ivory" : "bg-ground",
              i > 0 && "max-md:shadow-[inset_0_1px_0_var(--color-ink)] md:shadow-[inset_1px_0_0_var(--color-ink)]",
            )}
          >
            <PanelHead dark={l.dark} left={l.id} right={<span className="tnum">{`0${i + 1}`}</span>} />
            <div className={cx("p-5", l.dark ? "shadow-[inset_0_-1px_0_#2a2a2c]" : "shadow-[inset_0_-1px_0_var(--color-ink)]")}>
              <p className="text-2xl font-semibold tracking-[-0.02em] uppercase">{l.title}</p>
              <p className={cx("mt-2 text-xs leading-relaxed", l.dark ? "text-ivory-3" : "text-fg-3")}>{l.sub}</p>
            </div>
            <ul className="flex flex-1 flex-col gap-3 p-5 text-xs">
              {l.yes.map((y) => (
                <li key={y} className="flex items-start gap-2.5">
                  <Check size={14} strokeWidth={2} className="mt-px shrink-0 text-signal" aria-hidden />
                  {y}
                </li>
              ))}
              {l.no.map((n) => (
                <li key={n} className={cx("flex items-start gap-2.5 line-through", l.dark ? "text-ivory-3" : "text-fg-4")}>
                  <Minus size={14} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
                  {n}
                </li>
              ))}
            </ul>
            <div className="p-5 pt-0">
              <Link href="/resolution" className="group flex h-9 items-stretch">
                <span className="flex w-9 items-center justify-center bg-signal text-on-signal" aria-hidden>
                  <ArrowRight size={14} strokeWidth={2} />
                </span>
                <span className={cx("label flex flex-1 items-center justify-center", l.dark ? "bg-ivory text-ink group-hover:bg-hover" : "bg-ink text-ivory group-hover:bg-ink-2")}>
                  View resolution
                </span>
              </Link>
            </div>
          </div>
        ))}
      </div>
      <p className="label mt-4 text-fg-3">* Testnet: Layer 1 runs on a single simulation node, not a Chainlink DON; disputes are decided by the Eros team through a sandbox oracle, not by UMA voters.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ built on + footer */

/** Live ticker: chain values read now, and protocol constants. No logos, no claims. */
function LiveTicker() {
  const head = useHead();
  const m = useMarket(ENGINE, head.data?.number).data;
  const now = useClock(head.data ? head.data.timestamp + BigInt(Math.floor((Date.now() - head.data.at) / 1000)) : undefined);
  const T = m?.listing.scheduledT;
  const items = [
    `Block ${head.data ? head.data.number.toLocaleString("en-US") : "…"}`,
    `Stage ${m ? STAGE[m.risk.stage] : "…"}`,
    `Pricing ${m ? PRICING[m.risk.pricingMode] : "…"}`,
    `Traders ${m ? `${m.participants}/${m.listing.maxTraders}` : "…"}`,
    `Open interest ${m ? lotsToClaims(m.oiLots) : "…"}`,
    `To halt ${T !== undefined ? (T > now ? fmtDuration(T - now) : "passed") : "…"}`,
    "Tick 0.001",
    "Lot 0.001 claim",
    "1 claim pays 1 USDC on YES",
    "Chain 10143",
  ];
  const row = [...items, ...items];
  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="LIVE_TICKER" index={4} />
      <div className="frame mt-6 overflow-hidden">
        <div className="marquee flex w-max" aria-hidden>
          {row.map((s, i) => (
            <span key={i} className="label tnum flex h-12 items-center gap-3 px-8 font-semibold whitespace-nowrap text-fg shadow-[inset_-1px_0_0_var(--color-ink)]">
              <span className="h-2 w-2 bg-signal" />
              {s}
            </span>
          ))}
        </div>
        <p className="sr-only">{items.join(". ")}</p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="shadow-[inset_0_1px_0_var(--color-ink)]">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-6 px-4 py-8 md:px-8">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/eros-markets-lockup-on-light.svg" alt="Eros Markets" className="h-[14px] w-auto" />
          <p className="label mt-3 text-fg-3">© 2026 Eros Markets · Monad testnet</p>
        </div>
        <nav className="label flex gap-6 text-fg-3" aria-label="Footer">
          <Link href="/markets" className="hover:text-fg">Markets</Link>
          <Link href={`/m/${ENGINE}`} className="hover:text-fg">Trade</Link>
          <Link href="/resolution" className="hover:text-fg">Resolution</Link>
          <Link href="/portfolio" className="hover:text-fg">Portfolio</Link>
        </nav>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <main>
      <Hero />
      <LiveMarket />
      <Mechanism />
      <Resolution />
      <LiveTicker />
      <Footer />
    </main>
  );
}
