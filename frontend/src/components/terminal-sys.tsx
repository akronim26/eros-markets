"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Trash2 } from "lucide-react";
import type { Address } from "viem";
import type { MarketSnapshot } from "@/lib/reads";
import { STAGE, PRICING } from "@/lib/enums";
import { lotsToClaims } from "@/lib/units";
import styles from "./terminal-sys.module.css";

const COMMANDS = ["status", "book", "risk", "help", "clear"] as const;
type Entry = { id: number; command: string; lines: string[]; block?: string };
type Props = { engine: Address; market?: MarketSnapshot; readError: boolean };

function response(command: string, market: MarketSnapshot | undefined, readError: boolean): string[] {
  if (command === "help") return [
    "status  Market activity and trading stage",
    "book    Best bid, best ask and spread",
    "risk    Pricing, leverage cap and funding",
    "clear   Clear the console",
    "Choose a shortcut or type a command. No wallet needed.",
  ];
  if (!["status", "book", "risk"].includes(command)) return [`Unknown command: ${command}`, "Type help to see what you can explore."];
  if (!market) return [readError ? "Could not read the market. The connection will retry automatically." : "Reading Monad testnet… Try this command again in a moment."];
  const warning = readError ? ["Connection interrupted. Showing the last available snapshot."] : [];
  if (command === "book") {
    const price = (tick: number) => tick ? (tick / 1000).toFixed(3) : "No resting orders";
    return [...warning,
      `Best bid     ${price(market.bestBid)}`,
      `Best ask     ${price(market.bestAsk)}`,
      `Spread       ${market.bestBid && market.bestAsk ? ((market.bestAsk - market.bestBid) / 1000).toFixed(3) : "Unavailable"}`,
      `Open interest  ${lotsToClaims(market.oiLots)} claims`,
      "Prices are per YES claim, in test collateral.",
    ];
  }
  if (command === "risk") return [...warning,
    `Deployment ceiling  ${market.listing.deploymentCapX}x`,
    `Pricing             ${PRICING[market.risk.pricingMode] ?? "Unknown"}`,
    `Index window        ${market.risk.indexAvailable ? "Available" : "Unavailable"}`,
    `Mark price          ${market.risk.markAvailable ? "Available" : "Unavailable"}`,
    `Funding             ${market.fundingEnabled ? "Enabled" : "Disabled"}`,
    "The ceiling is not a guarantee of available leverage.",
  ];
  return [...warning,
    "Network       Monad testnet / 10143",
    `Market        ${market.halted ? "Halted" : market.active ? "Active" : "Awaiting activation"}`,
    `Stage         ${STAGE[market.risk.stage] ?? "Unknown"}`,
    `Participants  ${market.participants} / ${market.listing.maxTraders}`,
    `Open interest ${lotsToClaims(market.oiLots)} claims`,
  ];
}

/** A bounded, read-only console: commands never evaluate code or send transactions. */
export function TerminalSys({ engine, market, readError }: Props) {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [cleared, setCleared] = useState(false);
  const draft = useRef("");
  const sequence = useRef(0);
  const prompt = useRef<HTMLInputElement>(null);
  const output = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entries.length && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [entries]);

  function run(value: string) {
    const command = value.trim().toLowerCase();
    if (!command) return;
    setHistory((old) => [...old, command].slice(-20));
    setCursor(-1);
    draft.current = "";
    setInput("");
    if (command === "clear") {
      setEntries([]);
      setCleared(true);
    } else {
      const entry: Entry = { id: ++sequence.current, command, lines: response(command, market, readError), block: ["status", "book", "risk"].includes(command) ? market?.block.toString() : undefined };
      setEntries((old) => [...old, entry].slice(-6));
      setCleared(false);
    }
  }

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { setInput(""); setCursor(-1); draft.current = ""; return; }
    if (event.key === "Tab" && !event.shiftKey && input.trim()) {
      const matches = COMMANDS.filter((c) => c.startsWith(input.trim().toLowerCase()));
      if (matches.length === 1 && matches[0] !== input.trim().toLowerCase()) {
        event.preventDefault(); setInput(matches[0]); setCursor(-1);
      }
    }
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || !history.length) return;
    if (event.key === "ArrowDown" && cursor === -1) return;
    event.preventDefault();
    if (cursor === -1 && event.key === "ArrowUp") draft.current = input;
    const next = event.key === "ArrowUp" ? Math.min(cursor + 1, history.length - 1) : Math.max(cursor - 1, -1);
    setCursor(next);
    setInput(next === -1 ? draft.current : history[history.length - 1 - next]);
  }

  return (
    <section className={styles.terminal} aria-label="Interactive testnet console">
      <div className={styles.header}>
        <h3 className="label">TERMINAL.SYS</h3>
        <span className={styles.badge}><span aria-hidden />Read only</span>
      </div>
      <div className={styles.intro}>
        <span>Go ahead. Take a look under the hood.</span>
        <button type="button" onClick={() => { run("clear"); prompt.current?.focus(); }} aria-label="Clear terminal output" title="Clear terminal output"><Trash2 size={14} aria-hidden /></button>
      </div>
      <div className={styles.shortcuts} aria-label="Console commands">
        {COMMANDS.filter((c) => c !== "clear").map((command) => (
          <button type="button" key={command} onClick={() => run(command)} data-selected={entries.at(-1)?.command === command}>
            <span aria-hidden>›</span> {command}
          </button>
        ))}
      </div>
      <div ref={output} className={styles.output} role="log" aria-label="Console output" aria-live={entries.length ? "polite" : "off"} aria-relevant="additions" tabIndex={0}>
        {!entries.length && (cleared ? <p className={styles.hint}>Console cleared. What would you like to explore?</p> : <>
          <div className={styles.command}><span>$ status</span>{market && <span>Block {market.block.toString()}</span>}</div>
          <pre>{response("status", market, readError).join("\n")}</pre>
          <p className={styles.hint}>Try <span>book</span> to inspect the order book.</p>
        </>)}
        {entries.map((entry) => (
          <div key={entry.id} className={styles.entry}>
            <div className={styles.command}><span>$ {entry.command}</span>{entry.block && <span>Block {entry.block}</span>}</div>
            <pre>{entry.lines.join("\n")}</pre>
          </div>
        ))}
      </div>
      <form className={styles.prompt} onSubmit={(event) => { event.preventDefault(); run(input); }}>
        <span aria-hidden className={styles.promptSymbol}>❯</span>
        <label className="sr-only" htmlFor="terminal-sys-command">Terminal command</label>
        <input id="terminal-sys-command" ref={prompt} value={input} onChange={(event) => { setInput(event.target.value); setCursor(-1); draft.current = event.target.value; }} onKeyDown={keys} maxLength={64} placeholder="Type help to get started" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
        <button type="submit" disabled={!input.trim()} aria-label="Run terminal command"><ArrowRight size={17} aria-hidden /></button>
      </form>
      <div className={styles.footer}>
        <span>↑↓ history <span className={styles.completionHint}>· Tab complete</span></span>
        <Link href={`/m/${engine}`}>Open market <ArrowUpRight size={13} aria-hidden /></Link>
      </div>
    </section>
  );
}
