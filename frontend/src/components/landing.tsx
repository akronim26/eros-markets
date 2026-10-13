"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useHead, useMarket } from "@/lib/reads";
import { markets } from "@/config/deployment";
import { isSpotOnly } from "@/config/native";
import { PRICING, STAGE } from "@/lib/enums";
import { fmtDuration, lotsToClaims } from "@/lib/units";
import { SectionRule } from "./ui";
import { EventPerpDemo } from "./event-perp-demo";
import { MarketLifecycle } from "./market-lifecycle";
import { OracleLayers } from "./oracle-layers";

const ACTIVE_MARKET = markets.find((market) => !market.archived && !isSpotOnly(market.engine));
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
      <h1 className="display leading-[1.05] text-fg">
        <span className="block text-[clamp(1.5rem,6.3vw,5.5rem)]"><Scramble text="PERPETUAL FUTURES" /></span>
        <span className="mt-2 block text-[clamp(2.75rem,10vw,8rem)] text-signal-text"><Scramble text="ON EVENTS." /></span>
      </h1>
      <MarketLifecycle />
      <p className="mx-auto mt-7 max-w-[58ch] text-base leading-relaxed text-fg-2 md:text-lg">
        Trade your view on what happens next. Go long or short on event probabilities with Eros Markets,
        powered by a fully on-chain order book.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/markets" className="ui-button group inline-flex min-h-11 items-stretch">
          <span className="ui-arrow flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden>
            <ArrowRight size={15} strokeWidth={2} />
          </span>
          <span className="ui-button-label ui-sweep label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Explore markets</span>
        </Link>
        <Link href="#how-it-works" className="ui-button label frame inline-flex min-h-11 items-center px-5 text-fg hover:bg-hover">
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

/* ------------------------------------------------------------------ mechanism */

function Mechanism() {
  return (
    <section id="how-it-works" className="mx-auto max-w-[1280px] scroll-mt-36 px-4 pb-24 md:px-8">
      <SectionRule name="HOW_EVENT_PERPS_WORK" index={2} />
      <h2 className="display mt-6 text-[clamp(2rem,4vw,3.5rem)] leading-tight text-fg uppercase">
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
          <h2 className="display text-[clamp(2rem,4vw,3.5rem)] leading-tight text-fg uppercase">An oracle of its own.</h2>
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
      <SectionRule name="EXPLORE_EROS" index={4} />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-6">
        <div className="max-w-[65ch]">
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Your next market is an event.</h2>
          <p className="mt-3 text-sm leading-relaxed text-fg-2">
            Explore event perpetual futures on Monad testnet. Connect your wallet, or sign in with email to create one.
          </p>
        </div>
        <Link href="/markets" className="ui-button group inline-flex min-h-11 items-stretch">
          <span className="ui-arrow flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden><ArrowRight size={15} strokeWidth={2} /></span>
          <span className="ui-button-label ui-sweep label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Browse all markets</span>
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
      <LiveTicker />
    </main>
  );
}
