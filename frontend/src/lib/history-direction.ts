import type { HistoryEvent } from "./history";
import { orderSideLabel } from "./position-label";

type Direction = ReturnType<typeof orderSideLabel>;
type OrderIdentity = { trader: bigint; tick: bigint; isBuy: boolean };

function unsigned(value: unknown): bigint | undefined {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return;
  if (!["string", "number", "bigint"].includes(typeof value) || !/^\d+$/.test(String(value))) return;
  return BigInt(String(value));
}

/** Fill has no direction bit. Use its preceding maker OrderPlaced, never the current position. */
export function historyDirections(events: readonly HistoryEvent[], traderId: number | undefined, makerOrders: readonly HistoryEvent[] = []): Map<string, Direction> {
  const directions = new Map<string, Direction>();
  if (!Number.isSafeInteger(traderId) || !traderId || traderId < 0) return directions;
  const trader = BigInt(traderId);
  const orders = new Map<string, OrderIdentity>();
  const key = (engine: string, id: bigint) => `${engine.toLowerCase()}:${id}`;
  const sorted = [...events, ...makerOrders].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const event of sorted) {
    if (typeof event.engine !== "string") continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(event.payload); } catch { continue; }
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    if (event.kind === "OrderPlaced") {
      const id = unsigned(p.id), owner = unsigned(p.trader), flags = unsigned(p.flags), tick = unsigned(p.tick);
      if (id === undefined || id === 0n) continue;
      // A malformed replacement must not leave a previous identity available.
      orders.delete(key(event.engine, id));
      if (owner === undefined || owner === 0n || flags === undefined || flags > 255n || tick === undefined || tick < 1n || tick > 999n) continue;
      const order = { trader: owner, tick, isBuy: (flags & 1n) !== 0n };
      orders.set(key(event.engine, id), order);
      if (owner === trader) directions.set(event.id, orderSideLabel(order.isBuy));
    } else if (event.kind === "Fill") {
      const id = unsigned(p.makerOrder), maker = unsigned(p.maker), taker = unsigned(p.taker), tick = unsigned(p.tick);
      if (id === undefined || maker === undefined || taker === undefined || maker === taker) continue;
      const order = orders.get(key(event.engine, id));
      if (!order || order.trader !== maker || order.tick !== tick) continue;
      if (maker === trader) directions.set(event.id, orderSideLabel(order.isBuy));
      else if (taker === trader) directions.set(event.id, orderSideLabel(!order.isBuy));
    } else if (event.kind === "OrderCancelled") {
      const id = unsigned(p.id);
      if (id === undefined) continue;
      const order = orders.get(key(event.engine, id));
      if (order?.trader === trader) directions.set(event.id, orderSideLabel(order.isBuy));
    }
  }
  return directions;
}

/** Exact account-side fills for entry-basis replay. Unexplained position changes forbid inference. */
export function historyPositionFills(events: readonly HistoryEvent[], traderId: number | undefined, makerOrders: readonly HistoryEvent[] = []) {
  const fills: { signedLots: bigint; tick: number; feeQ: bigint }[] = [];
  const directions = historyDirections(events, traderId, makerOrders);
  let allPositionChangesKnown = Number.isSafeInteger(traderId) && !!traderId && traderId > 0;
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    // Their accounting differs from an ordinary fill. Leave the entry basis unavailable.
    if (event.kind === "PairReduction" || event.kind === "AccountTakenOver") allPositionChangesKnown = false;
    if (event.kind !== "Fill") continue;
    const direction = directions.get(event.id);
    if (!direction) { allPositionChangesKnown = false; continue; }
    const p = JSON.parse(event.payload);
    const lots = unsigned(p.size), tick = unsigned(p.tick);
    const fee = unsigned(unsigned(p.maker) === BigInt(traderId!) ? p.makerFeeQ : p.takerFeeQ);
    if (lots === undefined || lots === 0n || tick === undefined || tick < 1n || tick > 999n || fee === undefined) {
      allPositionChangesKnown = false; continue;
    }
    fills.push({ signedLots: direction === "Buy YES" ? lots : -lots, tick: Number(tick), feeQ: fee });
  }
  return { fills, allPositionChangesKnown };
}
