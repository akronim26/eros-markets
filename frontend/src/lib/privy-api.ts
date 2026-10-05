"use client";
import { getAccessToken } from "@privy-io/react-auth";
import { useQuery } from "@tanstack/react-query";
import { useWalletSession } from "@/components/wallet-session";
export async function privyRequest<T>(path: string, body?: unknown, assertCurrent?: () => void): Promise<T> {
  const token = await getAccessToken();
  assertCurrent?.();
  if (!token) throw new Error("Log in again to continue.");
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body, (_, v) => typeof v === "bigint" ? v.toString() : v) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data as T;
}
export type Permissions = { configured: boolean; workerOnline?: boolean; modes: { mode: "trade" | "protect"; signer: string; policy: string; granted: boolean; observedAt?: number; engines: string[] }[] };
export function usePermissions(address?: string) {
  const session = useWalletSession();
  return useQuery({ queryKey: ["permissions", address], enabled: !!address && session.authenticated && session.embedded,
    queryFn: () => privyRequest<Permissions>(`/api/permissions?wallet=${address}`), refetchInterval: 15000, retry: false });
}
