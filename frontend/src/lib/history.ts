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
export async function readHistory(chainId: number, engine: string, owner: string | undefined, trader: number | undefined, head: bigint, signal?: AbortSignal, assets?: { vault: string; token: string }): Promise<HistorySnapshot> {
  const meta = await indexerQuery<{ _meta: { progressBlock: number; isReady: boolean }[] }>(`query($chain:Int!){_meta(where:{chainId:{_eq:$chain}}){progressBlock isReady}}`, { chain: chainId }, signal);
  const progress = meta._meta[0]?.progressBlock;
  if (progress === undefined) throw new Error("History is still syncing.");
  const through = Math.min(Number(head), progress);
  const events: HistoryEvent[] = [];
  let exhausted = !owner;
  if (owner) for (let offset = 0; offset < 20000; offset += 1000) {
    const data = await indexerQuery<{ TradingEvent: HistoryEvent[] }>(`query($chain:Int!,$engine:String!,$owner:String!,$trader:numeric!,$block:Int!,$offset:Int!){TradingEvent(where:{chainId:{_eq:$chain},engine:{_eq:$engine},block:{_lte:$block},_or:[{owner:{_eq:$owner}},{trader:{_eq:$trader}},{maker:{_eq:$trader}},{taker:{_eq:$trader}}]},order_by:[{block:asc},{logIndex:asc}],limit:1000,offset:$offset){${FIELDS}}}`, { chain: chainId, engine: engine.toLowerCase(), owner: owner.toLowerCase(), trader: trader ?? -1, block: through, offset }, signal);
    events.push(...data.TradingEvent);
    if (data.TradingEvent.length < 1000) { exhausted = true; break; }
  }
  if (owner && assets) {
    const data = await indexerQuery<{ TradingEvent: HistoryEvent[]; CollateralTransfer: { id: string; from: string; to: string; atoms: string; block: number; logIndex: number; timestamp: string; txHash: `0x${string}` }[] }>(`query($chain:Int!,$owner:String!,$vault:String!,$token:String!,$block:Int!){
      TradingEvent(where:{chainId:{_eq:$chain},source:{_eq:$vault},engine:{_eq:""},owner:{_eq:$owner},block:{_lte:$block}},order_by:[{block:desc},{logIndex:desc}],limit:1000){${FIELDS}}
      CollateralTransfer(where:{chainId:{_eq:$chain},token:{_eq:$token},block:{_lte:$block},_or:[{from:{_eq:$vault},to:{_eq:$owner}},{from:{_eq:$owner},to:{_eq:$vault}}]},order_by:[{block:desc},{logIndex:desc}],limit:1000){id from to atoms block logIndex timestamp txHash}
    }`, { chain: chainId, owner: owner.toLowerCase(), vault: assets.vault.toLowerCase(), token: assets.token.toLowerCase(), block: through }, signal);
    events.push(...data.TradingEvent, ...data.CollateralTransfer.map((e) => ({ ...e, engine: "", owner, kind: "VaultTransfer", payload: JSON.stringify(e) })));
    events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  }
  const prices = await indexerQuery<{ TradingEvent: HistoryEvent[] }>(`query($chain:Int!,$engine:String!,$block:Int!){TradingEvent(where:{chainId:{_eq:$chain},engine:{_eq:$engine},block:{_lte:$block},kind:{_in:["ObservationAccepted","PerpObservationRecorded","Fill"]}},order_by:[{block:desc},{logIndex:desc}],limit:2000){${FIELDS}}}`, { chain: chainId, engine: engine.toLowerCase(), block: through }, signal);
  return { events, prices: prices.TradingEvent.reverse(), progress: through, complete: exhausted && !!meta._meta[0]?.isReady };
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
