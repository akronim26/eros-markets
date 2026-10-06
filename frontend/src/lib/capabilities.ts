import { encodeAbiParameters, keccak256, type ContractFunctionArgs, type Hex } from "viem";
import calibration from "@/config/risk-calibration.json";
import { engineAbi } from "@/abi/engine";

export type RiskParams = ContractFunctionArgs<typeof engineAbi, "pure", "profileHashOf">[0];
// Exact published synthetic parameters. The canonical hash is checked before using the lens.
const raw = calibration.riskParams;
const envelope = (e: typeof raw.realized) => ({ hSecs: e.hSecs.map(BigInt), sigmaWad: e.sigmaWad.map(BigInt), validFrom: BigInt(e.validFrom), validUntil: BigInt(e.validUntil) });
const profile: RiskParams = {
  h0Secs: BigInt(raw.h0Secs), absorptionClaimsPerMin: BigInt(raw.absorptionClaimsPerMin), queueSecs: BigInt(raw.queueSecs),
  hazard0WadPerDay: BigInt(raw.hazard0WadPerDay), hazard1WadPerDay: BigInt(raw.hazard1WadPerDay), epsilonWad: BigInt(raw.epsilonWad),
  gammaWad: BigInt(raw.gammaWad), sWad: BigInt(raw.sWad), lambdaWadPerClaim: BigInt(raw.lambdaWadPerClaim),
  template: raw.template, calibrated: raw.calibrated, deploymentCapX: BigInt(raw.deploymentCapX),
  realized: envelope(raw.realized), templateEnv: envelope(raw.templateEnv),
};
export const riskProfiles: Record<string, RiskParams> = { [calibration.profileHash.toLowerCase()]: profile };
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
