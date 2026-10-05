"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BrandImage } from "./brand-image";
import { ArrowRight, Check, Minus } from "lucide-react";
import { useHead, useMarket } from "@/lib/reads";
import { markets } from "@/config/deployment";
import { PRICING, STAGE } from "@/lib/enums";
import { fmtDuration, fmtUtc, lotsToClaims, shortAddr } from "@/lib/units";
import { Num, SectionRule, cx } from "./ui";
import { EventPerpDemo } from "./event-perp-demo";
import { MarketLifecycle } from "./market-lifecycle";

const ENGINE = markets[0].engine;
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
        <Link href={`/m/${ENGINE}`} className="group inline-flex min-h-11 items-stretch">
          <span className="flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden>
            <ArrowRight size={15} strokeWidth={2} />
          </span>
          <span className="label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Explore the testnet</span>
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
      <SectionRule name="TESTNET_STATUS" index={4} />
      <h2 className="mt-6 text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Explore the testnet build</h2>
      <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-fg-2">
        Inspect the order book, connect a wallet, and follow the market lifecycle on Monad.
        The current deployment is a fixture market for testing; its live status appears below.
      </p>
      <div className="frame mt-6 grid grid-cols-1 bg-ground md:grid-cols-2">
        {/* terminal */}
        <div className="flex min-h-[300px] flex-col bg-ink md:shadow-[inset_-1px_0_0_var(--color-line-strong)]">
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
        <div className="flex min-h-[300px] flex-col shadow-[inset_0_1px_0_var(--color-line-strong)] md:shadow-none">
          <PanelHead left="MARK.DITHER" right={<span className="tnum">76×76</span>} />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="aspect-square w-full max-w-[420px]">
              <MarkDither />
            </div>
          </div>
        </div>
        {/* metrics */}
        <div className="flex flex-col shadow-[inset_0_1px_0_var(--color-line-strong)] md:shadow-[inset_0_1px_0_var(--color-line-strong),inset_-1px_0_0_var(--color-line-strong)]">
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
        <div className="flex flex-col shadow-[inset_0_1px_0_var(--color-line-strong)]">
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
                        <span className={cx("h-2 w-2", isNext ? "bg-signal" : passed ? "bg-fg-4" : "shadow-[inset_0_0_0_1px_var(--color-line-strong)]")} aria-hidden />
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
              <div className="h-full bg-fg" style={{ width: `${Math.min(100, Math.max(0, life))}%` }} />
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
          <h2 className="text-2xl font-semibold tracking-[-0.02em] text-fg uppercase">Know how your market settles</h2>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-fg-2">
            Every event needs a clear answer. After trading halts, evidence supports a proposed outcome,
            with time to challenge it before settlement. Here is how the resolution system works.
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
              i > 0 && "max-md:shadow-[inset_0_1px_0_var(--color-line-strong)] md:shadow-[inset_1px_0_0_var(--color-line-strong)]",
            )}
          >
            <PanelHead dark={l.dark} left={l.id} right={<span className="tnum">{`0${i + 1}`}</span>} />
            <div className={cx("p-5", l.dark ? "shadow-[inset_0_-1px_0_#2a2a2c]" : "shadow-[inset_0_-1px_0_var(--color-line-strong)]")}>
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
                <span className={cx("label flex flex-1 items-center justify-center", l.dark ? "bg-ivory text-ink group-hover:bg-[#dcdad2]" : "bg-action text-on-action group-hover:bg-action-hover")}>
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
    "Settlement: YES 1 / NO 0",
    "Test collateral / fully backed 1x",
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
        <Link href={`/m/${ENGINE}`} className="group inline-flex min-h-11 items-stretch">
          <span className="flex w-11 items-center justify-center bg-signal text-on-signal" aria-hidden><ArrowRight size={15} strokeWidth={2} /></span>
          <span className="label flex items-center bg-action px-5 text-on-action group-hover:bg-action-hover">Open testnet terminal</span>
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

function Footer() {
  return (
    <footer className="shadow-[inset_0_1px_0_var(--color-line-strong)]">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-end justify-between gap-6 px-4 py-8 md:px-8">
        <div>
          <BrandImage className="h-[14px]" />
          <p className="mt-3 text-xs text-fg-2">Perpetual futures on event outcomes.</p>
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
      <EventMarkets />
      <Mechanism />
      <Resolution />
      <LiveMarket />
      <LiveTicker />
      <Footer />
    </main>
  );
}
