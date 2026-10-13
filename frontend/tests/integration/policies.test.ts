import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedPolicy, policyMatches } from "../../src/server/policy";
import { directionalCap, liveCalibration, riskProfiles, verifiedProfile, type RiskParams } from "../../src/lib/capabilities";
import { engineAbi } from "../../src/abi/engine";
import { encodeAbiParameters, keccak256 } from "viem";
test("policy check rejects extra allowances, altered decoded arguments and other chains", () => {
  const p = expectedPolicy("protect");
  assert.equal(policyMatches(p, "protect"), true);
  assert.equal(policyMatches(expectedPolicy("trade"), "protect"), false);
  for (const change of [
    (p: any) => p.rules.push({ action: "ALLOW", method: "personal_sign", conditions: [] }),
    (p: any) => p.rules[0].conditions[0].value = "1",
    (p: any) => p.rules[0].conditions.pop(),
    (p: any) => p.rules[0].conditions[3].abi[0].inputs[0].components.reverse(),
  ]) { const altered = structuredClone(p); change(altered); assert.equal(policyMatches(altered, "protect"), false); }
});
test("capabilities require a matching profile, live ordered envelopes and direction-specific limits", () => {
  const envelope = { hSecs: [300n], sigmaWad: [0n], validFrom: 0n, validUntil: 1000n };
  const p: RiskParams = { h0Secs: 300n, absorptionClaimsPerMin: 1000n, queueSecs: 0n, hazard0WadPerDay: 1n, hazard1WadPerDay: 1n, epsilonWad: 10n ** 16n, gammaWad: 15n * 10n ** 17n, sWad: 5n * 10n ** 15n, lambdaWadPerClaim: 10n ** 12n, template: 2, calibrated: true, deploymentCapX: 5n, realized: envelope, templateEnv: envelope };
  const hash = keccak256(encodeAbiParameters(engineAbi.find((x) => x.type === "function" && x.name === "profileHashOf")!.inputs, [p]));
  riskProfiles[hash] = p;
  assert.equal(verifiedProfile(hash, 2, 5n), p);
  assert.equal(verifiedProfile(hash, 0, 5n), undefined);
  assert.equal(liveCalibration(p, 999n), true); assert.equal(liveCalibration(p, 1000n), false);
  assert.equal(directionalCap(2, false, true, 5n), 1n); assert.equal(directionalCap(2, true, true, 5n), 3n);
  assert.equal(directionalCap(0, true, false, 5n), 1n);
  delete riskProfiles[hash];
});
