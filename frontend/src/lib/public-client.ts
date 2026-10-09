import { createPublicClient, http } from "viem";
import { chain } from "@/config/chain";
import { pooledReadTransport } from "./read-rpc-transport";

// Deployless aggregation preserves one pinned block without depending on a
// Multicall3 deployment (fresh rehearsal chains do not contain one).
const readRpc = process.env.NEXT_PUBLIC_READ_RPC_URL;
// Server-side policy/automation reads need an absolute endpoint. This private
// env value is not inlined into browser bundles by Next.
const transportUrl = typeof window === "undefined" && readRpc?.startsWith("/") ? process.env.MONAD_RPC_URL || undefined : readRpc || undefined;
const serverPool = typeof window === "undefined" && chain.id === 10143 && !!process.env.MONAD_RPC_URL;
export const client = createPublicClient({ chain, batch: { multicall: { deployless: true, batchSize: 8192, wait: 24 } },
  transport: serverPool ? pooledReadTransport(process.env.MONAD_RPC_URL!,
    process.env.MONAD_FRONTEND_READ_FALLBACK_URLS ?? process.env.MONAD_READ_FALLBACK_URLS,
    process.env.MONAD_FRONTEND_READ_RPC_CAPACITIES ?? process.env.MONAD_READ_RPC_CAPACITIES)
    : http(transportUrl, { batch: { batchSize: 8, wait: 16 }, retryCount: 2, retryDelay: 1000 }) });
