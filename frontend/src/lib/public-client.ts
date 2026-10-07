import { createPublicClient, http } from "viem";
import { chain } from "@/config/chain";

// Deployless aggregation preserves one pinned block without depending on a
// Multicall3 deployment (fresh rehearsal chains do not contain one).
const readRpc = process.env.NEXT_PUBLIC_READ_RPC_URL;
// Server-side policy/automation reads need an absolute endpoint. This private
// env value is not inlined into browser bundles by Next.
const transportUrl = typeof window === "undefined" && readRpc?.startsWith("/") ? process.env.MONAD_RPC_URL || undefined : readRpc || undefined;
export const client = createPublicClient({ chain, batch: { multicall: { deployless: true, batchSize: 8192, wait: 24 } }, transport: http(transportUrl, { batch: { batchSize: 8, wait: 16 }, retryCount: 2, retryDelay: 1000 }) });
