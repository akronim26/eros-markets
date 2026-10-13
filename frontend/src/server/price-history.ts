import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeEventLog, encodeEventTopics, type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { chain } from "@/config/chain";
import { marketByEngine } from "@/config/deployment";
import { validatedEvents, type HistoryEvent } from "@/lib/history";
import { client, logTimes, scanLogs, type RawLog } from "./log-scan";

/**
 * Stored chart history for one engine: the same three event kinds the indexer serves
 * (ObservationAccepted, PerpObservationRecorded, Fill), kept for a rolling span on disk
 * so a fresh page opens with a populated chart instead of an empty live window.
 * Only finalized blocks are stored; each refresh reads just the blocks after the last one.
 */
export type StoredPrices = { engine: string; from: number; through: number; spanSeconds: number; prices: HistoryEvent[] };

const KINDS = ["ObservationAccepted", "PerpObservationRecorded", "Fill"] as const;
const TOPICS = KINDS.map((eventName) => encodeEventTopics({ abi: engineAbi, eventName })[0] as Hex);
const SPAN_SECONDS = Math.max(3600, Math.min(7 * 86400, Math.round(Number(process.env.PRICE_HISTORY_HOURS || 24) * 3600)));
// Monad blocks are ~0.4 s; over-fetch the first backfill and trim by timestamp afterwards.
const SPAN_BLOCKS = BigInt(Math.ceil(SPAN_SECONDS / 0.3));
const MIN_REFRESH_MS = 5000;
const DIR = resolve(/* turbopackIgnore: true */ process.env.PRICE_HISTORY_DIR || "var/price-history");


const file = (engine: string) => resolve(DIR, `${chain.id}-${engine.toLowerCase()}.json`);
function load(engine: string): StoredPrices | undefined {
  try {
    const stored = JSON.parse(readFileSync(file(engine), "utf8")) as StoredPrices;
    if (stored.engine !== engine.toLowerCase() || !Number.isSafeInteger(stored.through)) return undefined;
    return { ...stored, prices: validatedEvents(stored.prices, stored.through) };
  } catch { return undefined; }
}
function save(stored: StoredPrices) {
  const path = file(stored.engine), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  renameSync(tmp, path);
}

async function toEvents(engine: Address, raw: RawLog[]): Promise<HistoryEvent[]> {
  const times = await logTimes(raw);
  return raw.map((l) => {
    const decoded = decodeEventLog({ abi: engineAbi, data: l.data, topics: l.topics });
    const block = BigInt(l.blockNumber), logIndex = Number(BigInt(l.logIndex));
    return {
      id: `${chain.id}_${block}_${logIndex}`, engine: engine.toLowerCase(), kind: decoded.eventName, block: Number(block), logIndex,
      timestamp: times.get(block)!.toString(), txHash: l.transactionHash,
      payload: JSON.stringify(decoded.args, (_, v) => typeof v === "bigint" ? v.toString() : v),
    };
  });
}

async function refreshNow(engine: Address): Promise<StoredPrices> {
  const market = marketByEngine(engine);
  if (!market) throw new Error("Market is not in the verified deployment.");
  const head = (await client().getBlock({ blockTag: "finalized" }));
  const previous = load(engine);
  const floor = head.number > SPAN_BLOCKS ? head.number - SPAN_BLOCKS : 0n;
  const start = previous && BigInt(previous.through) >= floor ? BigInt(previous.through) + 1n
    : floor > market.deployBlock ? floor : market.deployBlock;
  const events: HistoryEvent[] = previous && BigInt(previous.through) >= floor ? [...previous.prices] : [];
  events.push(...await toEvents(engine, await scanLogs({ address: [engine], topics: [TOPICS] }, start, head.number)));
  const cutoff = Number(head.timestamp) - SPAN_SECONDS;
  const prices = validatedEvents(events.filter((e) => Number(e.timestamp) >= cutoff && KINDS.includes(e.kind as typeof KINDS[number])), Number(head.number));
  const stored: StoredPrices = { engine: engine.toLowerCase(), from: prices[0]?.block ?? Number(start), through: Number(head.number), spanSeconds: SPAN_SECONDS, prices };
  save(stored);
  return stored;
}

const inflight = new Map<string, Promise<StoredPrices>>();
const refreshedAt = new Map<string, { at: number; value: StoredPrices }>();
/** Deduplicated per engine; concurrent page loads share one RPC refresh. */
export async function storedPrices(engine: Address): Promise<StoredPrices> {
  const key = engine.toLowerCase(), recent = refreshedAt.get(key);
  if (recent && Date.now() - recent.at < MIN_REFRESH_MS) return recent.value;
  let pending = inflight.get(key);
  if (!pending) {
    pending = refreshNow(engine).then((value) => { refreshedAt.set(key, { at: Date.now(), value }); return value; })
      // An RPC outage still serves the last stored span; the live window covers recent blocks.
      .catch((error) => { const stored = load(engine); if (stored) return stored; throw error; })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
