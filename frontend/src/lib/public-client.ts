import { createPublicClient, http } from "viem";
import { chain } from "@/config/chain";

export const client = createPublicClient({ chain, batch: { multicall: { batchSize: 8192, wait: 24 } }, transport: http(undefined, { batch: { wait: 16 }, retryCount: 2, retryDelay: 1000 }) });
