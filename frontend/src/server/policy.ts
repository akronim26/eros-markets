import { engineAbi } from "@/abi/engine";
import { markets } from "@/config/deployment";
import type { PolicyCreateParams } from "@privy-io/node/resources";

export type SignerMode = "trade" | "protect";
export const delegatedEngines = markets.map((m) => m.engine.toLowerCase());
export function expectedPolicy(mode: SignerMode): PolicyCreateParams {
  return { version: "1.0", name: `eros-${mode}`, chain_type: "ethereum", rules: ["placeOrder", "cancel", "cancelAll"].map((fn) => ({
    name: `${mode}: ${fn}`, method: "eth_sendTransaction", action: "ALLOW", conditions: [
      { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "10143" },
      { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" },
      { field_source: "ethereum_transaction", field: "to", operator: "in", value: delegatedEngines },
      { field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: fn, abi: JSON.parse(JSON.stringify(engineAbi.filter((a) => a.type === "function" && a.name === fn))) },
      ...(mode === "protect" && fn === "placeOrder" ? [{ field_source: "ethereum_calldata" as const, field: "placeOrder.p.reduceOnly", operator: "eq" as const, value: "true", abi: JSON.parse(JSON.stringify(engineAbi.filter((a) => a.type === "function" && a.name === fn))) }] : []),
    ],
  })) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function policyMatches(actual: { version: string; chain_type: string; rules: { action: string; method: string; conditions: unknown }[] }, mode: SignerMode) {
  const normalize = (r: typeof actual.rules) => r.map(({ action, method, conditions }) => ({ action, method, conditions }));
  return actual.version === "1.0" && actual.chain_type === "ethereum" && canonical(normalize(actual.rules)) === canonical(normalize(expectedPolicy(mode).rules));
}
