import { readFileSync } from 'node:fs';
import { createPublicClient, defineChain, getAddress, http } from 'viem';
import { inspectNativeSnapshot } from '../src/native/collector.js';
import { readKuruSnapshot, type KuruReadClient } from '../src/native/kuru.js';
import { nativeRulesHash, parseNativeRules } from '../src/native/rules.js';
import { decimalWad, json } from '../src/math.js';

/**
 * Read-only native source probe (NM-F03..F06): one pinned-block Kuru YES-book capture, validated
 * against the native rules. No signer, key, engine or transaction.
 *   node dist/scripts/native-observe.js <rpcUrl> <rules.json> [finalized|latest]
 */
async function main() {
  const [rpcUrl, rulesPath, tagArg = 'finalized', ...extra] = process.argv.slice(2);
  if (!rpcUrl || !rulesPath || extra.length || (tagArg !== 'finalized' && tagArg !== 'latest')) throw new Error('BAD_ARGUMENTS');
  const rules = parseNativeRules(JSON.parse(readFileSync(rulesPath, 'utf8')));
  const chain = defineChain({ id: Number(rules.chainId), name: 'native-source', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }) });
  const snap = await readKuruSnapshot(client as unknown as KuruReadClient, getAddress(rules.kuruOrderBook), tagArg);
  const r = inspectNativeSnapshot(rules, snap, BigInt(Date.now()), null, 5000n);
  const s = r.summary;
  console.log(json({
    rulesHash: nativeRulesHash(rules), status: r.status, reason: r.reason, evidenceHash: r.evidenceHash,
    block: { number: snap.blockNumber, hash: snap.blockHash, timestamp: snap.blockTimestamp },
    levels: { bids: snap.l2.bids.length, asks: snap.l2.asks.length }, ammVault: { bid: snap.vaultBidSize, ask: snap.vaultAskSize },
    impact: s && { bid: s.impactBidWad === null ? null : decimalWad(s.impactBidWad),
      ask: s.impactAskWad === null ? null : decimalWad(s.impactAskWad),
      mid: s.priceWad === null ? null : decimalWad(s.priceWad), bidDepthLots: s.bidDepthLots, askDepthLots: s.askDepthLots },
  }));
  return r.status === 'COLLECTING' || r.status === 'INVALID_DEPTH' ? 0 : 2;
}

main().then(code => { process.exitCode = code; }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
