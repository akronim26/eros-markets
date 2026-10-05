"use client";
import { useQuery } from "@tanstack/react-query";
import { chain } from "@/config/chain";
import { INDEXER_URL, readHistory } from "./history";
import { readAssets } from "./market-discovery";
import type { Address } from "viem";

export function useHistory(engine: string, owner?: string, trader?: number, block?: bigint) {
  return useQuery({ queryKey: ["history", chain.id, engine, owner, trader], enabled: !!INDEXER_URL && block !== undefined,
    queryFn: async ({ signal }) => readHistory(chain.id, engine, owner, trader, block!, signal, owner ? await readAssets(engine as Address, block!) : undefined), refetchInterval: 15000 });
}
