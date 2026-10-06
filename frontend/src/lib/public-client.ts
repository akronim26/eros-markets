import { createPublicClient, http } from "viem";
import { chain } from "@/config/chain";

// Deployless aggregation preserves one pinned block without depending on a
// Multicall3 deployment (fresh rehearsal chains do not contain one).
export const client = createPublicClient({ chain, batch: { multicall: { deployless: true, batchSize: 8192, wait: 24 } }, transport: http(undefined, { batch: { wait: 16 }, retryCount: 2, retryDelay: 1000 }) });
