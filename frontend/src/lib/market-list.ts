"use client";
import { useQuery } from "@tanstack/react-query";
import { markets } from "@/config/deployment";
import { discoverMarkets } from "./market-discovery";

export function useMarketList() {
  const q = useQuery({ queryKey: ["market-list"], queryFn: discoverMarkets, staleTime: 15000, refetchInterval: 30000 });
  return { ...q, markets: q.data?.markets ?? markets };
}
