import { mkdirSync, writeFileSync } from "node:fs";
import { expectedPolicy } from "../src/server/policy";
mkdirSync("privy-policies", { recursive: true });
for (const mode of ["trade", "protect"] as const) writeFileSync(`privy-policies/eros-${mode}.json`, `${JSON.stringify(expectedPolicy(mode), null, 2)}\n`);
console.log("Wrote reviewable Privy policy definitions in frontend/privy-policies/. No API changes were made.");
