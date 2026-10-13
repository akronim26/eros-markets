import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodeEventLog, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { resolutionOracleAbi } from "@/abi/resolutionOracle";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { chain } from "@/config/chain";
import { deployment, marketByEngine } from "@/config/deployment";
import { nativeBinding } from "@/config/native";
import { client, logTimes, scanLogs, type RawLog } from "./log-scan";

/**
 * Every on-chain resolution step for one market, with block time and transaction: oracle lifecycle
 * (keyed by the market id topic), engine halt/finality/settlement preparation, and the native vault's
 * sync and redemptions. Stored on disk and extended from the last finalized block on each refresh.
 */
export type ResolutionEvent = { source: "oracle" | "engine" | "vault"; kind: string; block: number; logIndex: number; timestamp: number; txHash: Hex; args: Record<string, string | number | boolean | string[]> };
export type StoredResolution = { engine: string; through: number; events: ResolutionEvent[] };

const ORACLE_EVENTS = ["EarlyCheckRequested", "EarlyCheckCleared", "HaltRecorded", "ResolutionRequested", "ProposedL1", "ProposalRecorded", "Asserted", "Disputed", "AssertionRejected", "Finalized", "Voided"] as const;
const ENGINE_EVENTS = ["MarketHalted", "OracleFinalityAccepted", "InvalidPriceCaptured", "SnapshotPreparationProgress", "PayoutPreparationProgress", "ClaimsPrepared", "ClaimsEnabled"] as const;
const VAULT_EVENTS = ["ResolutionSynced", "Redeemed"] as const;
const topics = (abi: Abi, names: readonly string[]) => names.map((eventName) => encodeEventTopics({ abi, eventName } as never)[0] as Hex);
const DIR = resolve(/* turbopackIgnore: true */ process.env.RESOLUTION_EVENTS_DIR || "var/resolution-events");
const file = (engine: string) => resolve(DIR, `${chain.id}-${engine.toLowerCase()}.json`);
const json = (v: unknown): ResolutionEvent["args"] => JSON.parse(JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x));

function load(engine: string): StoredResolution | undefined {
  try {
    const s = JSON.parse(readFileSync(file(engine), "utf8")) as StoredResolution;
    return s.engine === engine.toLowerCase() && Number.isSafeInteger(s.through) && Array.isArray(s.events) ? s : undefined;
  } catch { return undefined; }
}
function save(s: StoredResolution) {
  const path = file(s.engine), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, path);
}

async function decode(raw: RawLog[], source: ResolutionEvent["source"], abi: Abi): Promise<ResolutionEvent[]> {
  const times = await logTimes(raw);
  return raw.map((l) => {
    const d = decodeEventLog({ abi, data: l.data, topics: l.topics }) as { eventName: string; args: unknown };
    return { source, kind: d.eventName, block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)),
      timestamp: Number(times.get(BigInt(l.blockNumber))!), txHash: l.transactionHash, args: json(d.args) };
  });
}

async function refreshNow(engine: Address): Promise<StoredResolution> {
  const market = marketByEngine(engine);
  if (!market?.oracleMarketId) throw new Error("Market is not in the verified deployment.");
  const head = await client().getBlock({ blockTag: "finalized" });
  const previous = load(engine);
  const from = previous ? BigInt(previous.through) + 1n : market.deployBlock;
  const events = previous ? [...previous.events] : [];
  if (from <= head.number) {
    const native = nativeBinding(engine);
    const [oracle, eng, vault] = await Promise.all([
      scanLogs({ address: [deployment.oracle.resolutionOracle], topics: [topics(resolutionOracleAbi, ORACLE_EVENTS), market.oracleMarketId] }, from, head.number),
      scanLogs({ address: [engine], topics: [topics(engineAbi, ENGINE_EVENTS)] }, from, head.number),
      native ? scanLogs({ address: [native.vault], topics: [topics(nativeVaultAbi, VAULT_EVENTS)] }, from, head.number) : Promise.resolve([]),
    ]);
    events.push(...await decode(oracle, "oracle", resolutionOracleAbi), ...await decode(eng, "engine", engineAbi), ...await decode(vault, "vault", nativeVaultAbi));
  }
  const unique = new Map(events.map((e) => [`${e.block}:${e.logIndex}`, e]));
  const stored = { engine: engine.toLowerCase(), through: Number(head.number),
    events: [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex) };
  save(stored);
  return stored;
}

const inflight = new Map<string, Promise<StoredResolution>>();
const recent = new Map<string, { at: number; value: StoredResolution }>();
export async function resolutionEvents(engine: Address): Promise<StoredResolution> {
  const key = engine.toLowerCase(), hit = recent.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let pending = inflight.get(key);
  if (!pending) {
    pending = refreshNow(engine).then((value) => { recent.set(key, { at: Date.now(), value }); return value; })
      .catch((error) => { const stored = load(engine); if (stored) return stored; throw error; })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}
