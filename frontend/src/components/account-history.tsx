"use client";
import type { Address } from "viem";
import { useHistory } from "@/lib/history-reads";
import { historyTotals, INDEXER_URL, type HistoryEvent } from "@/lib/history";
import { useTrader } from "@/lib/reads";
import { atomsToUsdc, qToMoney, lotsToClaims, tickToPrice } from "@/lib/units";
import { explorerTx } from "@/config/chain";
import { useOwner } from "./wallet";
import { Row } from "./ui";

function activityDetail(event: HistoryEvent) {
  const p = JSON.parse(event.payload);
  if (event.kind === "Fill" || event.kind === "OrderPlaced") return `${lotsToClaims(BigInt(p.size))} claims @ ${tickToPrice(Number(p.tick))}`;
  if (event.kind === "PairReduction") return `${lotsToClaims(BigInt(p.lots))} claims @ ${tickToPrice(Number(p.tick))}`;
  if (p.atoms !== undefined) return `${atomsToUsdc(BigInt(p.atoms), 6)} collateral`;
  if (event.kind === "OrderCancelled") return `${lotsToClaims(BigInt(p.size))} claims`;
  return "—";
}

export function AccountHistory({ engine, traderId, block }: { engine: Address; traderId?: number; block?: bigint }) {
  const owner = useOwner();
  const q = useHistory(engine, owner.address, traderId, block);
  const pinned = useTrader(engine, owner.address, q.data ? BigInt(q.data.progress) : undefined);
  if (!owner.connected) return <p className="p-4 text-sm text-fg-3">Log in to see your trading history.</p>;
  if (!INDEXER_URL) return <p className="p-4 text-sm text-fg-3">Historical data is not connected yet. Your current balances are read directly from the contracts.</p>;
  if (q.isError) return <p role="alert" className="p-4 text-sm text-ask">History unavailable. <button className="underline" onClick={() => q.refetch()}>Retry</button></p>;
  if (!q.data) return <p role="status" className="p-4 text-sm text-fg-3">Loading history…</p>;
  const { events, progress, complete } = q.data;
  const totals = historyTotals(events, traderId ?? 0);
  const account = pinned.data?.account;
  const preview = account?.preview;
  const pnl = complete && pinned.data?.block === BigInt(progress) && preview?.id.markAvailable && !account?.claimed
    ? preview.markEquityQ - (totals.allocated - totals.released) * 10n ** 18n : undefined;
  return <section aria-label="Account history" className="min-w-0 p-4">
    <p className="mb-3 text-xs text-fg-3">History through block {progress}{block && block > BigInt(progress) ? ` · ${block - BigInt(progress)} blocks behind` : ""}{!complete ? " · partial history; totals unavailable" : ""}</p>
    {complete && <dl className="mb-4 grid gap-x-8 sm:grid-cols-2">
      <Row k="Account P&L at history block" v={pnl === undefined ? "unavailable" : qToMoney(pnl).usdc} />
      <Row k="Net allocated" v={atomsToUsdc(totals.allocated - totals.released, 6)} />
      <Row k="Funding paid (signed)" v={qToMoney(totals.fundingQ).usdc} /><Row k="Premium paid" v={qToMoney(totals.premiumQ).usdc} />
      <Row k="Trading fees" v={qToMoney(totals.feesQ).usdc} /><Row k="Paired reduction fees" v={qToMoney(totals.liquidationFeesQ).usdc} />
    </dl>}
    {!events.length ? <p className="text-sm text-fg-3">No account activity recorded through this block.</p> : <div className="max-h-80 overflow-auto"><table className="w-full min-w-[460px] text-left text-xs">
      <thead className="hair-b text-fg-3"><tr><th className="py-2 font-normal">Time (UTC)</th><th className="font-normal">Activity</th><th className="font-normal">Details</th><th className="font-normal">Transaction</th></tr></thead>
      <tbody>{events.slice(-200).reverse().map((e) => <tr key={e.id} className="hair-b"><td className="py-2 pr-3">{new Date(Number(e.timestamp) * 1000).toISOString().slice(0, 19).replace("T", " ")}</td><td className="pr-3">{e.kind.replace(/([a-z])([A-Z])/g, "$1 $2")}</td><td className="pr-3 tnum">{activityDetail(e)}</td><td><a className="underline" href={explorerTx(e.txHash)} target="_blank" rel="noreferrer">View ↗</a></td></tr>)}</tbody>
    </table></div>}
    {events.length > 200 && <p className="mt-2 text-xs text-fg-3">Showing the latest 200 activities. Totals include the loaded history.</p>}
  </section>;
}
