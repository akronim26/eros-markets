import { parseAbi, type Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "./public-client";
import { readPinned } from "./pinned-read";

export const reserveAbi = parseAbi(["function shares(address) view returns (uint256)", "function noticedShares(address) view returns (uint256)", "function noticeAt(address) view returns (uint64)", "function preparedAtoms(address) view returns (uint256)", "function maxRedeem(address) view returns (uint256)", "function holderCount() view returns (uint256)", "function totalShares() view returns (uint256)", "function notice()"]);

/** A new head updates the next poll without abandoning an in-flight owner read. */
export function releasePreviewOptions(engine: Address, owner: Address | undefined, traderId: number, amount: bigint, block: bigint) {
  return {
    queryKey: ["release-preview", engine.toLowerCase(), owner?.toLowerCase(), traderId, amount.toString()] as const,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: () => readPinned(block, () => client.readContract({ address: engine, abi: engineAbi, functionName: "previewRelease", args: [traderId, amount], blockNumber: block })),
  };
}

export function reserveOptions(engine: Address, owner: Address | undefined, block: bigint) {
  return {
    queryKey: ["reserve", engine.toLowerCase(), owner?.toLowerCase()] as const,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: () => readPinned(block, async () => {
      const address = await client.readContract({ address: engine, abi: engineAbi, functionName: "reserveVault", blockNumber: block });
      const [holders, total] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [{ address, abi: reserveAbi, functionName: "holderCount" }, { address, abi: reserveAbi, functionName: "totalShares" }] });
      if (!owner) return { address, holders, total, user: undefined };
      const claimable = await client.readContract({ address: engine, abi: engineAbi, functionName: "claimableAtoms", args: [owner], blockNumber: block });
      const [shares, noticed, noticeAt, prepared, redeem] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: ["shares", "noticedShares", "noticeAt", "preparedAtoms", "maxRedeem"].map((functionName) => ({ address, abi: reserveAbi, functionName: functionName as "shares", args: [owner] })) });
      return { address, holders, total, user: { shares, noticed, noticeAt, prepared, redeem, claimable } };
    }),
  };
}
