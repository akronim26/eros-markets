import { deployment } from "@/config/deployment";
export type HistoryEvent = {
  id: string; engine: string; kind: string; block: number; logIndex: number; timestamp: string;
  txHash: `0x${string}`; owner?: string; trader?: string; maker?: string; taker?: string; orderId?: string; payload: string;
};
export type HistorySnapshot = { events: HistoryEvent[]; prices: HistoryEvent[]; progress: number; complete: boolean };
// An old testnet endpoint must not silently supply history for a fresh deployment.
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_DEPLOYMENT?.toLowerCase() === `${deployment.chainId}:${deployment.oracle.marketRegistry.toLowerCase()}`
  ? process.env.NEXT_PUBLIC_INDEXER_URL || "" : "";

export async function indexerQuery<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (!INDEXER_URL) throw new Error("Historical data is not connected yet.");
  const response = await fetch(INDEXER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("History service unavailable.");
  const body = await response.json();
  if (body.errors?.length || !body.data) throw new Error("History query failed. Check the indexer's schema and read permissions.");
  return body.data as T;
}

export const FIELDS = "id engine kind block logIndex timestamp txHash owner trader maker taker orderId payload";
export async function readHistory(chainId: number, engine: string, owner: string | undefined, trader: number | undefined, head: bigint, signal?: AbortSignal, assets?: { vault: string; token: string }, query: typeof indexerQuery = indexerQuery): Promise<HistorySnapshot> {
  const meta = await query<{ _meta: { progressBlock: number; isReady: boolean }[] }>(`query($chain:Int!){_meta(where:{chainId:{_eq:$chain}}){progressBlock isReady}}`, { chain: chainId }, signal);
  const progress = meta._meta[0]?.progressBlock;
  if (progress === undefined) throw new Error("History is still syncing.");
  if (!Number.isSafeInteger(progress) || progress < 0) throw new Error("History returned an invalid progress block.");
  const through = Math.min(Number(head), progress);
  const events: HistoryEvent[] = [];
  let exhausted = !owner;
  if (owner) for (let offset = 0; offset < 20000; offset += 1000) {
    const data = await query<{ TradingEvent: HistoryEvent[] }>(`query($chain:Int!,$engine:String!,$owner:String!,$trader:numeric!,$block:Int!,$offset:Int!){TradingEvent(where:{chainId:{_eq:$chain},engine:{_eq:$engine},block:{_lte:$block},_or:[{owner:{_eq:$owner}},{trader:{_eq:$trader}},{maker:{_eq:$trader}},{taker:{_eq:$trader}}]},order_by:[{block:asc},{logIndex:asc}],limit:1000,offset:$offset){${FIELDS}}}`, { chain: chainId, engine: engine.toLowerCase(), owner: owner.toLowerCase(), trader: trader ?? -1, block: through, offset }, signal);
    events.push(...data.TradingEvent);
    if (data.TradingEvent.length < 1000) { exhausted = true; break; }
  }
  let vaultComplete = true, transfersComplete = true;
  if (owner && assets) {
    vaultComplete = false; transfersComplete = false;
    for (let offset = 0; offset < 20000 && (!vaultComplete || !transfersComplete); offset += 1000) {
      const data = await query<{ TradingEvent: HistoryEvent[]; CollateralTransfer: { id: string; from: string; to: string; atoms: string; block: number; logIndex: number; timestamp: string; txHash: `0x${string}` }[] }>(`query($chain:Int!,$owner:String!,$vault:String!,$token:String!,$block:Int!,$offset:Int!){
        TradingEvent(where:{chainId:{_eq:$chain},source:{_eq:$vault},engine:{_eq:""},owner:{_eq:$owner},block:{_lte:$block}},order_by:[{block:asc},{logIndex:asc}],limit:1000,offset:$offset){${FIELDS}}
        CollateralTransfer(where:{chainId:{_eq:$chain},token:{_eq:$token},block:{_lte:$block},_or:[{from:{_eq:$vault},to:{_eq:$owner}},{from:{_eq:$owner},to:{_eq:$vault}}]},order_by:[{block:asc},{logIndex:asc}],limit:1000,offset:$offset){id from to atoms block logIndex timestamp txHash}
      }`, { chain: chainId, owner: owner.toLowerCase(), vault: assets.vault.toLowerCase(), token: assets.token.toLowerCase(), block: through, offset }, signal);
      events.push(...data.TradingEvent, ...data.CollateralTransfer.map((e) => ({ ...e, engine: "", owner, kind: "VaultTransfer", payload: JSON.stringify(e) })));
      vaultComplete ||= data.TradingEvent.length < 1000;
      transfersComplete ||= data.CollateralTransfer.length < 1000;
    }
  }
  const prices = await query<{ TradingEvent: HistoryEvent[] }>(`query($chain:Int!,$engine:String!,$block:Int!){TradingEvent(where:{chainId:{_eq:$chain},engine:{_eq:$engine},block:{_lte:$block},kind:{_in:["ObservationAccepted","PerpObservationRecorded","Fill"]}},order_by:[{block:desc},{logIndex:desc}],limit:2000){${FIELDS}}}`, { chain: chainId, engine: engine.toLowerCase(), block: through }, signal);
  return { events: validatedEvents(events, through), prices: validatedEvents(prices.TradingEvent, through), progress: through, complete: exhausted && vaultComplete && transfersComplete && !!meta._meta[0]?.isReady };
}

/** Reject malformed indexed payloads before rendering dates, amounts, prices or totals. */
export function validatedEvents(events: HistoryEvent[], through: number): HistoryEvent[] {
  const unique = new Map<string, HistoryEvent>();
  for (const e of events) {
    if (!e || typeof e.id !== "string" || typeof e.kind !== "string" || !Number.isSafeInteger(e.block) || e.block < 0 || e.block > through
      || !Number.isSafeInteger(e.logIndex) || e.logIndex < 0 || !/^\d+$/.test(e.timestamp)
      || !Number.isSafeInteger(Number(e.timestamp)) || Number(e.timestamp) > 8640000000000
      || !/^0x[\da-fA-F]{64}$/.test(e.txHash)) throw new Error("History returned an invalid event.");
    let p: Record<string, unknown>;
    try { p = JSON.parse(e.payload); } catch { throw new Error("History returned an invalid event payload."); }
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("History returned an invalid event payload.");
    const integer = (key: string, signed = false) => {
      const value = p[key];
      if (!(typeof value === "string" || typeof value === "number") || !(signed ? /^-?\d+$/ : /^\d+$/).test(String(value))) throw new Error("History returned an invalid amount.");
    };
    if (p.atoms !== undefined) integer("atoms");
    if (["CashAllocated", "Released"].includes(e.kind)) integer("atoms");
    if (e.kind === "AccountSynced") { integer("fundingPaymentQ", true); integer("premiumQ"); }
    if (["Fill", "OrderPlaced", "OrderCancelled"].includes(e.kind)) integer("size");
    if (["Fill", "OrderPlaced", "PairReduction"].includes(e.kind)) {
      integer("tick"); if (Number(p.tick) < 1 || Number(p.tick) > 999) throw new Error("History returned an invalid price.");
    }
    if (e.kind === "Fill") for (const k of ["maker", "taker", "makerFeeQ", "takerFeeQ"]) integer(k);
    if (e.kind === "PairReduction") for (const k of ["target", "partner", "lots", "feeTargetQ", "feePartnerQ"]) integer(k);
    if (e.kind === "ObservationAccepted") {
      integer("observedAt"); integer("priceWad");
      if (typeof p.depthValid !== "boolean" || BigInt(String(p.priceWad)) > 10n ** 18n) throw new Error("History returned an invalid observation.");
    }
    if (e.kind === "PerpObservationRecorded") {
      integer("t"); integer("midWad");
      if (typeof p.valid !== "boolean" || BigInt(String(p.midWad)) > 10n ** 18n) throw new Error("History returned an invalid observation.");
    }
    const old = unique.get(e.id);
    if (old && JSON.stringify(old) !== JSON.stringify(e)) throw new Error("History returned conflicting events.");
    unique.set(e.id, e);
  }
  return [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export function historyTotals(events: HistoryEvent[], trader: number) {
  let allocated = 0n, released = 0n, fundingQ = 0n, premiumQ = 0n, feesQ = 0n, liquidationFeesQ = 0n;
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const p = JSON.parse(event.payload);
    if (event.kind === "CashAllocated") allocated += BigInt(p.atoms);
    if (event.kind === "Released") released += BigInt(p.atoms);
    if (event.kind === "AccountSynced") { fundingQ += BigInt(p.fundingPaymentQ); premiumQ += BigInt(p.premiumQ); }
    if (event.kind === "PairReduction") {
      if (Number(p.target) === trader) liquidationFeesQ += BigInt(p.feeTargetQ);
      if (Number(p.partner) === trader) liquidationFeesQ += BigInt(p.feePartnerQ);
    }
    // PairedPosting mirrors Fill; never add its fees or volume a second time.
    if (event.kind === "Fill") {
      if (Number(p.maker) === trader) feesQ += BigInt(p.makerFeeQ);
      if (Number(p.taker) === trader) feesQ += BigInt(p.takerFeeQ);
    }
  }
  return { allocated, released, fundingQ, premiumQ, feesQ, liquidationFeesQ };
}
