import type { Hex } from "viem";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { resolutionOracleAbi } from "@/abi/resolutionOracle";
import { canonicalRead } from "./deployment-check";
import { client } from "./public-client";
import { PublicError } from "./public-error";
import type { OracleBinding } from "./oracle-binding";

export async function readOracleSnapshot(id: Hex, oracle: OracleBinding, block: bigint, now: bigint) {
  return canonicalRead(block, async () => {
    const [question, rules, core, resolution, evidenceURI, bond, liveness, claim] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
      { address: oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getQuestion", args: [id] },
      { address: oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getRules", args: [id] },
      { address: oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [id] },
      { address: oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "getResolution", args: [id] },
      { address: oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "evidenceURIOf", args: [id] },
      { address: oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "bondFor", args: [id] },
      { address: oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "livenessFor", args: [id] },
      { address: oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "renderClaim", args: [id] },
    ] });
    if (oracle.engine && core.engine.toLowerCase() !== oracle.engine.toLowerCase()) throw new PublicError("Oracle record does not match the verified engine.");
    return { id, oracle, question, rules, core, resolution, evidenceURI, block, now, bond, liveness, claim };
  });
}
