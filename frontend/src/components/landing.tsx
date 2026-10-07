"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useHead, useMarket } from "@/lib/reads";
import { markets } from "@/config/deployment";
import { PRICING, STAGE } from "@/lib/enums";
import { fmtDuration, lotsToClaims } from "@/lib/units";
import { SectionRule, cx } from "./ui";
import { EventPerpDemo } from "./event-perp-demo";
import { MarketLifecycle } from "./market-lifecycle";
import { OracleLayers } from "./oracle-layers";
import { TerminalSys } from "./terminal-sys";

const ACTIVE_MARKET = markets.find((market) => !market.archived);
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ interactions */

/** Keep server and initial client markup identical; read motion preferences after mount. */
function useReducedMotion() {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  return reduceMotion;
}

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
    <span className={className} onMouseEnter={run}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>{out}</span>
    </span>
  );
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

function Hero() {
  return (
    <section className="mx-auto max-w-[1280px] px-4 pt-12 pb-16 text-center md:px-8 md:pt-20 md:pb-24">
      <p className="label mb-6 inline-flex items-center gap-2 text-fg-3">
        <span className="h-2 w-2 bg-signal" aria-hidden />
        Built on Monad · Public testnet
      </p>
      <h1 className="pixel leading-[1.05] text-fg">
        <span className="block text-[clamp(1.5rem,6.3vw,5.5rem)]"><Scramble text="PERPETUAL FUTURES" /></span>
        <span className="mt-2 block text-[clamp(2.75rem,10vw,8rem)] text-signal-text"><Scramble text="ON EVENTS." /></span>
      </h1>
      <MarketLifecycle />
      <p className="mx-auto mt-7 max-w-[58ch] text-base leading-relaxed text-fg-2 md:text-lg">
        Trade your view on what happens next. Go long or short on event probabilities with Eros Markets,
        powered by a fully on-chain order book.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/markets" className="group inline-flex min-h-11 items-stretch">
          <span className="flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden>
            <ArrowRight size={15} strokeWidth={2} />
          </span>
          <span className="label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Explore markets</span>
        </Link>
        <Link href="#how-it-works" className="label frame inline-flex min-h-11 items-center px-5 text-fg hover:bg-hover">
          How event perps work
        </Link>
      </div>
      <p className="label mt-5 text-fg-3">Long / short positions · Limit orders · Outcome settlement</p>
    </section>
  );
}

const EVENT_EXAMPLES = [
  { category: "Politics", question: "Will the candidate win the election?" },
  { category: "Economics", question: "Will the next rate decision be a cut?" },
  { category: "Crypto", question: "Will BTC end the month above $100,000?" },
];

function EventMarkets() {
  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-20 md:px-8">
      <SectionRule name="EVENT_MARKETS" index={1} />
      <div className="mt-6 max-w-[70ch]">
        <h2 className="text-2xl font-semibold tracking-[-0.02em] text-fg uppercase md:text-3xl">The world moves. Trade your view.</h2>
        <p className="mt-3 text-sm leading-relaxed text-fg-2">
          Elections, rate decisions, crypto milestones. Event perpetuals turn a YES/NO question into a market:
          take a position on how the odds will move as new information comes in.
        </p>
      </div>
      <p className="label mt-6 text-fg-3">Illustrative questions · These are not live listings</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {EVENT_EXAMPLES.map((event) => (
          <div key={event.category} className="frame flex flex-col gap-6 bg-panel p-5">
            <span className="label flex items-center gap-2 text-signal-text"><span className="h-1.5 w-1.5 bg-signal" aria-hidden />{event.category}</span>
            <h3 className="max-w-[28ch] text-lg leading-snug font-medium text-fg">{event.question}</h3>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ live market bento */

function PanelHead({ left, right, dark }: { left: string; right?: React.ReactNode; dark?: boolean }) {
  return (
    <div className={cx("label flex h-8 items-center justify-between px-3", dark ? "text-ivory-3 shadow-[inset_0_-1px_0_#2a2a2c]" : "text-fg-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]")}>
      <span>{left}</span>
      {right}
    </div>
  );
}

/** The Eros mark rendered as a dot matrix: the depth ladder, with the Signal bar as the mark price. */
function MarkDither() {
  const reduceMotion = useReducedMotion();
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
        <rect key={i} x={d.x} y={d.y} width={cell * 0.62} height={cell * 0.62} fill={d.s ? "var(--color-signal)" : "var(--color-fg)"} opacity={d.s ? 1 : 0.35 + (d.d % 50) / 80}>
          {!reduceMotion && d.s && <animate attributeName="opacity" values="1;0.4;1" dur="3s" begin={`${(d.d % 30) / 10}s`} repeatCount="indefinite" />}
        </rect>
      ))}
    </svg>
  );
}

function LiveMarket() {
  return ACTIVE_MARKET ? <ActiveLiveMarket engine={ACTIVE_MARKET.engine} /> : (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="TESTNET_STATUS" index={4} />
      <div className="frame mt-6 bg-panel p-6">
        <h2 className="text-2xl font-semibold text-fg">The next event perp is on the way</h2>
        <p className="mt-3 text-sm text-fg-2">We’re preparing a new market. You can still manage previous demo balances from your portfolio.</p>
        <Link href="/portfolio" className="label mt-4 inline-flex min-h-11 items-center bg-signal px-4 text-on-signal">View portfolio</Link>
      </div>
    </section>
  );
}

function ActiveLiveMarket({ engine }: { engine: (typeof markets)[number]["engine"] }) {
  const head = useHead();
  const market = useMarket(engine, head.data?.number);
  const m = market.data;
  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="TESTNET_STATUS" index={4} />
      <h2 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Explore the testnet build</h2>
      <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-fg-2">
        Inspect the order book, connect a wallet, and follow the market lifecycle on Monad.
        Explore a real Polymarket event with test collateral. Leverage depends on live prices and risk limits.
      </p>
      <div className="frame mt-6 grid grid-cols-1 bg-ground md:grid-cols-2">
        <TerminalSys engine={engine} market={m} readError={head.isError || market.isError} />
        {/* mark */}
        <div className="flex min-h-[300px] flex-col shadow-[inset_0_1px_0_var(--color-line-strong)] md:shadow-none">
          <PanelHead left="MARK.DITHER" right={<span className="tnum">76×76</span>} />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="aspect-square w-full max-w-[420px]">
              <MarkDither />
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ mechanism */

function Mechanism() {
  return (
    <section id="how-it-works" className="mx-auto max-w-[1280px] scroll-mt-36 px-4 pb-24 md:px-8">
      <SectionRule name="HOW_EVENT_PERPS_WORK" index={2} />
      <h2 className="pixel mt-6 text-[clamp(2rem,4vw,3.5rem)] leading-tight text-fg uppercase">
        Move the odds.
      </h2>
      <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-fg-2">
        Pick a side. Change the probability. Watch your position react.
      </p>
      <EventPerpDemo />
    </section>
  );
}

/* ------------------------------------------------------------------ resolution layers */

function Resolution() {
  return (
    <section id="resolution" className="mx-auto max-w-[1280px] scroll-mt-28 px-4 pb-24 md:px-8">
      <SectionRule name="RESOLUTION" index={3} />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="pixel text-[clamp(2rem,4vw,3.5rem)] leading-tight text-fg uppercase">An oracle of its own.</h2>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-fg-2">
            From evidence to outcome. Explore the layers that decide how your market settles.
          </p>
        </div>
      </div>
      <OracleLayers />
      <p className="label mt-4 text-fg-3">* Testnet: Layer 1 runs on a single simulation node, not a Chainlink DON; disputes are decided by the Eros team through a sandbox oracle, not by UMA voters.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ built on + footer */

/** Live ticker: chain values read now, and protocol constants. No logos, no claims. */
function LiveTicker() {
  return ACTIVE_MARKET ? <ActiveLiveTicker engine={ACTIVE_MARKET.engine} /> : null;
}

function ActiveLiveTicker({ engine }: { engine: (typeof markets)[number]["engine"] }) {
  const head = useHead();
  const m = useMarket(engine, head.data?.number).data;
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
    "Settlement: YES 1 / NO 0",
    "Test collateral / dynamic leverage up to 5×",
    "Chain 10143",
  ];
  const row = [...items, ...items];
  return (
    <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8">
      <SectionRule name="EXPLORE_EROS" index={5} />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-6">
        <div className="max-w-[65ch]">
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Your next market is an event.</h2>
          <p className="mt-3 text-sm leading-relaxed text-fg-2">
            Explore event perpetual futures on Monad testnet. Connect your wallet, or sign in with email to create one.
          </p>
        </div>
        <Link href="/markets" className="group inline-flex min-h-11 items-stretch">
          <span className="flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden><ArrowRight size={15} strokeWidth={2} /></span>
          <span className="label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Browse all markets</span>
        </Link>
      </div>
      <div className="frame mt-6 overflow-hidden">
        <div className="marquee flex w-max" aria-hidden>
          {row.map((s, i) => (
            <span key={i} className="label tnum flex h-12 items-center gap-3 px-8 font-semibold whitespace-nowrap text-fg shadow-[inset_-1px_0_0_var(--color-line-strong)]">
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

export function Landing() {
  return (
    <main>
      <Hero />
      <EventMarkets />
      <Mechanism />
      <Resolution />
      <LiveMarket />
      <LiveTicker />
    </main>
  );
}
