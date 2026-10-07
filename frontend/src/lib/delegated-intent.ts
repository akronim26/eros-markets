import { PublicError } from "./public-error";
export type OrderIntent = { kind: number; isBuy: boolean; reduceOnly: boolean; tick: number; size: string; maxFills: number; expiryBlock: number };
export class DelegatedDeliveryError extends Error {
  constructor(message: string, readonly delivery: "rejected" | "pending" | "unknown") { super(message); }
}
export type DelegatedIntent = { wallet: string; engine: string; previewBlock: string; clientNonce: string; action: "placeOrder"; place: OrderIntent } |
  { wallet: string; engine: string; previewBlock: string; clientNonce: string; action: "cancel"; orderId: number } |
  { wallet: string; engine: string; previewBlock: string; clientNonce: string; action: "cancelAll" };
const integer = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
export function validateIntent(v: unknown, engines: readonly string[], protect = false): DelegatedIntent {
  if (!v || typeof v !== "object") throw new PublicError("Invalid trading request.");
  const x = v as Record<string, unknown>;
  if (typeof x.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.wallet) || typeof x.engine !== "string" || !engines.includes(x.engine.toLowerCase())) throw new PublicError("Wallet or market is not allowed.");
  if (typeof x.previewBlock !== "string" || !/^\d{1,20}$/.test(x.previewBlock) || typeof x.clientNonce !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(x.clientNonce)) throw new PublicError("Invalid preview or request ID.");
  if (x.action === "placeOrder") {
    const p = x.place as OrderIntent | undefined;
    if (!p || !integer(p.kind, 0, 2) || typeof p.isBuy !== "boolean" || typeof p.reduceOnly !== "boolean" || !integer(p.tick, 1, 999) || typeof p.size !== "string" || !/^\d{1,20}$/.test(p.size) || BigInt(p.size) <= 0n || BigInt(p.size) > 2n ** 64n - 1n || !integer(p.maxFills, 1, 255) || !integer(p.expiryBlock, 0, 0xffffffff)) throw new PublicError("Invalid order fields.");
    if (protect && (!p.reduceOnly || p.kind !== 1)) throw new PublicError("Protection permits only reduce-only IOC orders.");
    if (Object.keys(p).some((k) => !["kind", "isBuy", "reduceOnly", "tick", "size", "maxFills", "expiryBlock"].includes(k))) throw new PublicError("Unexpected order field.");
  } else if (x.action === "cancel") {
    if (!integer(x.orderId, 1, 0xffffffff)) throw new PublicError("Invalid order ID.");
  } else if (x.action !== "cancelAll") throw new PublicError("This action cannot be delegated.");
  if (Object.keys(x).some((k) => !["wallet", "engine", "previewBlock", "clientNonce", "action", ...(x.action === "placeOrder" ? ["place"] : x.action === "cancel" ? ["orderId"] : [])].includes(k))) throw new PublicError("Unexpected request field.");
  return x as DelegatedIntent;
}
