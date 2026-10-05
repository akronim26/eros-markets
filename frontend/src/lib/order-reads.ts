"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAbiItem, type Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { chain, LOG_BLOCK_CAP } from "@/config/chain";
import { client } from "./reads";
import { orderStatus, rememberedOrders, rememberOrders } from "./orders";
import { useHistory } from "./history-reads";

const placed = parseAbiItem("event OrderPlaced(uint32 indexed id, uint32 indexed trader, uint16 tick, uint64 size, uint8 flags, uint32 expiryBlock)");

export function useOrders(engine: Address, owner: Address | undefined, traderId: number | undefined, block: bigint | undefined) {
  const history = useHistory(engine, owner, traderId, block);
  return useQuery({
    queryKey: ["orders", engine, owner, traderId, block?.toString(), history.dataUpdatedAt],
    enabled: !!owner && traderId !== undefined && block !== undefined,
    queryFn: async () => {
      if (!traderId) return { block: block!, complete: true, orders: [] };
      const recent = await client.getLogs({ address: engine, event: placed, args: { trader: traderId },
        fromBlock: block! >= LOG_BLOCK_CAP ? block! - LOG_BLOCK_CAP + 1n : 0n, toBlock: block! });
      rememberOrders(chain.id, engine, owner!, recent.flatMap((l) => l.args.id === undefined ? [] : [l.args.id]));
      const indexedIds = history.data?.events.filter((e) => e.kind === "OrderPlaced").map((e) => Number(e.orderId)).filter((id) => Number.isInteger(id) && id > 0 && id <= 0xffffffff) ?? [];
      const ids = [...new Set([...rememberedOrders(chain.id, engine, owner!), ...indexedIds])];
      const [account, marketEpoch] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
        { address: engine, abi: engineAbi, functionName: "account", args: [owner!] },
        { address: engine, abi: engineAbi, functionName: "marketOrderEpoch" },
      ] });
      const values = await client.multicall({ blockNumber: block, allowFailure: false,
        contracts: ids.map((id) => ({ address: engine, abi: engineAbi, functionName: "getOrder", args: [id] } as const)) });
      const context = { traderId, block: block!, marketEpoch, accountEpoch: account.orderEpoch, positionVersion: account.positionVersion };
      return { block: block!, complete: !!history.data?.complete && !history.isError && BigInt(history.data.progress) + LOG_BLOCK_CAP >= block!, orders: values.map((order, i) => ({ id: ids[i], ...order, status: orderStatus(ids[i], order, context) }))
        .filter((order) => order.status === "live" || order.status === "stale") };
    },
  });
}
