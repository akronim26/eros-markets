"use client";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { useOrders } from "@/lib/order-reads";
import { useTx } from "@/lib/tx";
import { lotsToClaims, tickToPrice } from "@/lib/units";
import { useOwner } from "./wallet";
import { Button } from "./ui";
import { TxFeedback } from "./tx-feedback";

export function OpenOrders({ engine, traderId, block }: { engine: Address; traderId?: number; block?: bigint }) {
  const owner = useOwner();
  const q = useOrders(engine, owner.address, traderId, block);
  const tx = useTx();
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const disabled = busy || owner.wrongChain || !q.data || q.isError;
  const cancel = (id?: number) => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi,
    functionName: id === undefined ? "cancelAll" : "cancel", args: id === undefined ? [] : [id], label: id === undefined ? "cancel all orders" : `cancel order ${id}` }]);

  if (!owner.connected) return <p className="p-4 text-sm text-fg-3">Log in to see your open orders.</p>;
  return <section aria-label="Open orders" className="min-w-0 p-3">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-fg-3">{q.data ? `Orders checked at block ${q.data.block}` : "Reading your orders…"}</p>
      <Button disabled={disabled || !traderId} onClick={() => cancel()}>Cancel all</Button>
    </div>
    {q.isError ? <p role="alert" className="text-sm text-ask">Could not read orders. <button className="underline" onClick={() => q.refetch()}>Retry</button></p>
      : !q.data ? <p role="status" className="text-sm text-fg-3">Loading orders…</p>
      : q.data.orders.length === 0 ? <p className="text-sm text-fg-3">{q.data.complete ? "No open orders." : "No open orders found in your saved receipts or recent activity."}</p>
      : <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs">
        <thead className="hair-b text-fg-3"><tr>{["Order", "Side", "Price", "Remaining", "Status", ""].map((v) => <th key={v} className="py-2 pr-3 font-normal">{v}</th>)}</tr></thead>
        <tbody>{q.data.orders.map((o) => <tr key={o.id} className="hair-b">
          <td className="py-2 pr-3 tnum">{o.id}</td><td className="pr-3">{o.flags & 1 ? "Buy" : "Sell"}{o.flags & 2 ? " · reduce only" : ""}</td>
          <td className="pr-3 tnum">{tickToPrice(o.tick)}</td><td className="pr-3 tnum">{lotsToClaims(o.size)}</td>
          <td className="pr-3">{o.status === "live" ? "Resting" : "Stale · awaiting pruning"}</td>
          <td><Button size="sm" disabled={disabled || o.status !== "live"} onClick={() => cancel(o.id)} aria-label={`Cancel order ${o.id}`}>Cancel</Button></td>
        </tr>)}</tbody>
      </table></div>}
    {q.data && !q.data.complete && <p className="mt-3 text-xs text-fg-3">Older orders from other sessions may be missing. Cancel all cancels every resting order for this wallet in this market.</p>}
    {owner.wrongChain && <p className="mt-2 text-xs text-signal-text">Switch to Monad testnet to cancel orders.</p>}
    <div className="mt-2"><TxFeedback state={tx.state} /></div>
  </section>;
}
