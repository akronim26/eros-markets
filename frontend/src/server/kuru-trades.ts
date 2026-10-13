import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeEventLog, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { chain } from "@/config/chain";
import { nativeBinding } from "@/config/native";
import { client, logTimes, scanLogs } from "./log-scan";

/**
 * Kuru fills on a native market's YES and NO books for the last PRICE_HISTORY_HOURS (default 24),
 * stored on disk and extended from the last finalized block. Event layout verified against 115
 * public-testnet fills: `isBuy` is the taker's side, `price` is WAD, `filledSize` is lots.
 */
const TRADE = parseAbi(["event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)"]);
const TOPIC = encodeEventTopics({ abi: TRADE, eventName: "Trade" })[0] as Hex;
export type KuruTrade = { outcome: "yes" | "no"; block: number; logIndex: number; timestamp: number; txHash: Hex; tick: number; lots: string; takerBuy: boolean; maker: Address; taker: Address };
export type StoredKuruTrades = { engine: string; through: number; spanSeconds: number; trades: KuruTrade[] };

const SPAN_SECONDS = Math.max(3600, Math.min(7 * 86400, Math.round(Number(process.env.PRICE_HISTORY_HOURS || 24) * 3600)));
const SPAN_BLOCKS = BigInt(Math.ceil(SPAN_SECONDS / 0.3));
const DIR = resolve(/* turbopackIgnore: true */ process.env.KURU_TRADES_DIR || "var/kuru-trades");
const file = (engine: string) => resolve(DIR, `${chain.id}-${engine.toLowerCase()}.json`);

function load(engine: string): StoredKuruTrades | undefined {
  try {
    const s = JSON.parse(readFileSync(file(engine), "utf8")) as StoredKuruTrades;
    return s.engine === engine.toLowerCase() && Number.isSafeInteger(s.through) && Array.isArray(s.trades) ? s : undefined;
  } catch { return undefined; }
}
function save(s: StoredKuruTrades) {
  const path = file(s.engine), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, path);
}

async function refreshNow(engine: Address): Promise<StoredKuruTrades> {
  const b = nativeBinding(engine);
  if (!b) throw new Error("Not a native market.");
  const head = await client().getBlock({ blockTag: "finalized" });
  const previous = load(engine);
  const floor = head.number > SPAN_BLOCKS ? head.number - SPAN_BLOCKS : 0n;
  const keep = previous && BigInt(previous.through) >= floor;
  const from = keep ? BigInt(previous.through) + 1n : floor;
  const trades = keep ? [...previous.trades] : [];
  if (from <= head.number) {
    const raw = await scanLogs({ address: [b.yesBook, b.noBook], topics: [TOPIC] }, from, head.number);
    const times = await logTimes(raw);
    for (const l of raw) {
      const { args } = decodeEventLog({ abi: TRADE, data: l.data, topics: l.topics });
      if (args.price > 10n ** 18n || args.price % 10n ** 15n !== 0n) continue; // off the 0.001 grid: not a probability tick
      trades.push({ outcome: l.address.toLowerCase() === b.yesBook.toLowerCase() ? "yes" : "no", block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)), timestamp: Number(times.get(BigInt(l.blockNumber))!), txHash: l.transactionHash,
        tick: Number(args.price / 10n ** 15n), lots: args.filledSize.toString(), takerBuy: args.isBuy, maker: args.makerAddress, taker: args.takerAddress });
    }
  }
  const cutoff = Number(head.timestamp) - SPAN_SECONDS;
  const unique = new Map(trades.filter((t) => t.timestamp >= cutoff).map((t) => [`${t.block}:${t.logIndex}`, t]));
  const stored = { engine: engine.toLowerCase(), through: Number(head.number), spanSeconds: SPAN_SECONDS,
    trades: [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex) };
  save(stored);
  return stored;
}

const inflight = new Map<string, Promise<StoredKuruTrades>>();
const recent = new Map<string, { at: number; value: StoredKuruTrades }>();
export async function kuruTrades(engine: Address): Promise<StoredKuruTrades> {
  const key = engine.toLowerCase(), hit = recent.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  let pending = inflight.get(key);
  if (!pending) {
    pending = refreshNow(engine).then((value) => { recent.set(key, { at: Date.now(), value }); return value; })
      .catch((error) => { const stored = load(engine); if (stored) return stored; throw error; })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
