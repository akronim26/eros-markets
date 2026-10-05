import { encodeAbiParameters, keccak256, type ContractFunctionArgs, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";

export type RiskParams = ContractFunctionArgs<typeof engineAbi, "pure", "profileHashOf">[0];
// Add released calibration data here, keyed by its canonical hash. No guessed calibration.
export const riskProfiles: Record<string, RiskParams> = {};
const profileInputs = engineAbi.find((f) => f.type === "function" && f.name === "profileHashOf")!.inputs;
export function verifiedProfile(hash: Hex, template: number, cap: bigint) {
  const p = riskProfiles[hash.toLowerCase()];
  if (!p || p.template !== template || p.deploymentCapX > cap || keccak256(encodeAbiParameters(profileInputs, [p])) !== hash.toLowerCase()) return undefined;
  return p;
}
export function directionalCap(template: number, isLong: boolean, calibrated: boolean, cap: bigint) {
  if (!calibrated) return 1n;
  const limit = template === 0 ? 5n : template === 1 ? 3n : template === 2 && isLong ? 3n : 1n;
  return cap < limit ? cap : limit;
}
export function liveCalibration(p: RiskParams | undefined, now: bigint) {
  return !!p?.calibrated && [p.realized, p.templateEnv].every((e) => e.hSecs.length > 0 && e.hSecs.length === e.sigmaWad.length && now >= e.validFrom && now < e.validUntil && e.hSecs.every((h, i) => !i || h > e.hSecs[i - 1] && e.sigmaWad[i] >= e.sigmaWad[i - 1]));
}
