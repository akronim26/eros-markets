import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getAddress, keccak256, stringToHex } from 'viem';
import { record } from '../src/book.js';
import { json, uint } from '../src/math.js';
import { PRICING_POLICY } from '../src/rules.js';
import { parseNativeDeployment } from '../src/native/manifest.js';
import { NATIVE_DEPTH_POLICY, NATIVE_FAILURE_POLICY, NATIVE_TIMESTAMP_POLICY, nativeRulesHash, parseNativeRules } from '../src/native/rules.js';

/**
 * NM-F02 / NM-D04 input: build the native INDEX rules manifest from a DeployNativeMarket output and
 * print the engine-listing fields the existing ListMarket pack needs (indexSourceId, indexSigner,
 * indexRulesHash, depthNLots, maxSpreadWad). Offline: no RPC, key or transaction.
 *   node dist/scripts/native-rules.js <deployment.json> <signerAddress> <depthNLots> <maxSpreadWad> <out-rules.json> [perpMarketId]
 * `perpMarketId`: a perp listed under its own market id whose INDEX is this deployment's YES book
 * (the deployment's vault stays bound to its spot market).
 */
function main() {
  const [deploymentPath, signer, depthNLots, maxSpreadWad, outPath, perpMarketId, ...extra] = process.argv.slice(2);
  if (!deploymentPath || !signer || !depthNLots || !maxSpreadWad || !outPath || extra.length) throw new Error('BAD_ARGUMENTS');
  if (existsSync(outPath)) throw new Error('RULES_OUTPUT_EXISTS');
  parseNativeDeployment(JSON.parse(readFileSync(deploymentPath, 'utf8'))); // strict schema check first
  const d = record(JSON.parse(readFileSync(deploymentPath, 'utf8')));
  const str = (k: string) => { const v = d[k]; if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`MISSING_${k}`); return String(v); };
  const chainId = str('chainId'); uint(chainId, 256);
  // Deterministic source identity: one native source per (chain, YES book).
  const sourceId = keccak256(stringToHex(`eros-kuru-native-index:${chainId}:${getAddress(str('yesBook')).toLowerCase()}`));
  const rules = parseNativeRules({ schemaVersion: '1', venue: 'kuru', chainId, marketId: perpMarketId ?? str('marketId'), sourceId,
    kuruOrderBook: str('yesBook'), yesToken: str('yesToken'), noToken: str('noToken'), collateral: str('collateral'),
    outcomeVault: str('outcomeVault'), outcomeLabel: 'YES', erosRulesHash: str('erosRulesHash'), scheduledT: str('scheduledT'),
    depthNLots, maxSpreadWad, pricingPolicy: PRICING_POLICY, depthPolicy: NATIVE_DEPTH_POLICY,
    timestampPolicy: NATIVE_TIMESTAMP_POLICY, failurePolicy: NATIVE_FAILURE_POLICY });
  writeFileSync(outPath, json(rules) + '\n', { flag: 'wx' });
  console.log(json({ rules: outPath, engineListing: { indexSourceId: sourceId, indexSigner: getAddress(signer),
    indexRulesHash: nativeRulesHash(rules), depthNLots, maxSpreadWad, scheduledT: rules.scheduledT, token: rules.collateral },
    note: 'Use these exact values in the ListMarket pack; the publisher refuses a listing that does not pin them.' }));
}

main();
