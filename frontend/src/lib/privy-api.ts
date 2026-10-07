"use client";
import { useQuery } from "@tanstack/react-query";
import { useWalletSession } from "@/components/wallet-session";
import { DelegatedDeliveryError } from "./delegated-intent";
export async function privyRequest<T>(path: string, body?: unknown, assertCurrent?: () => void): Promise<T> {
  const { getAccessToken } = await import("@privy-io/react-auth");
  const token = await getAccessToken();
  assertCurrent?.();
  if (!token) throw new Error("Log in again to continue.");
  let response: Response;
  try {
    response = await fetch(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body, (_, v) => typeof v === "bigint" ? v.toString() : v) : undefined, signal: AbortSignal.timeout(30000) });
  } catch { throw new Error(body ? "The service did not confirm the result. Check wallet activity and rule status before retrying." : "The service is unavailable. Please retry."); }
  let data;
  try { data = await response.json(); } catch { throw new Error("The service returned an invalid response. Check the action's status before retrying."); }
  if (!response.ok) throw new DelegatedDeliveryError(data.error || "Request failed.",
    data.delivery === "rejected" || data.delivery === "pending" ? data.delivery : "unknown");
  return data as T;
}
export type Permissions = { configured: boolean; workerOnline?: boolean; modes: { mode: "trade" | "protect"; signer: string; policy: string; granted: boolean; observedAt?: number; engines: string[] }[] };
export function usePermissions(address?: string) {
  const session = useWalletSession();
  const enabled = !!address && session.authenticated && session.embedded;
  const query = useQuery({ queryKey: ["permissions", address, session.getSnapshot().version], enabled,
    queryFn: () => privyRequest<Permissions>(`/api/permissions?wallet=${address}`), refetchInterval: 15000, retry: false });
  return { ...query, data: enabled ? query.data : undefined };
}
