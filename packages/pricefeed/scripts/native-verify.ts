import { readFileSync } from 'node:fs';
import { createPublicClient, defineChain, getAddress, http, keccak256, parseAbi, type Address } from 'viem';
import { parseNativeDeployment } from '../src/native/manifest.js';
import { nativeRulesHash, parseNativeRules } from '../src/native/rules.js';
import { json } from '../src/math.js';

/**
 * Read-only verification of a native market deployment against the chain (NM-D01 / NM-D06).
 * No key, no transaction. Exit 0 only if every check passes.
 *   node dist/scripts/native-verify.js <rpc> <deployment.json> [rules.json] [engine]
 * `engine` other than the vault's: a perp listed under its own market id whose INDEX is this
 * deployment's YES book. The vault, tokens and books are still checked; the listing checks then apply
 * to that perp engine and to the market id the rules pin.
 */
const VAULT = parseAbi(['function registry() view returns (address)', 'function marketId() view returns (bytes32)',
  'function collateral() view returns (address)', 'function rulesHash() view returns (bytes32)', 'function scheduledT() view returns (uint64)',
  'function issuanceCap() view returns (uint256)', 'function yes() view returns (address)', 'function no() view returns (address)',
  'function engine() view returns (address)']);
const TOKEN = parseAbi(['function vault() view returns (address)', 'function marketId() view returns (bytes32)', 'function isYes() view returns (bool)',
  'function decimals() view returns (uint8)']);
const BOOK = parseAbi(['function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)']);
const REGISTRY = parseAbi(['function getMarketCore(bytes32) view returns ((address engine, address questionPtr, address rulesPtr, uint64 listedAt, uint64 windowStart, uint64 windowEnd, uint64 tau, bytes32 groupId, bool groupExclusive, bool hasFeed, uint32 l2DeadlineSecs, uint32 voidSecs, uint32 retryWindowSecs, uint32 earlyTtlSecs, address monitor, uint256 oiCapLots, bytes32 rulesHash, bytes32 specHash, bytes32 gateHash))']);
const ENGINE = parseAbi(['function listing() view returns ((bytes32 marketId, address token, address registry, address resolutionAuthority, address monitor, address governance, uint64 scheduledT, uint64 listedAt, bytes32 sourceHash, bytes32 rulesHash, (bool fallbackListed, uint64 captureGraceSecs, uint256 fallbackPriceWad, uint64 voidSecs) invalidRule, uint8 template, uint256 deploymentCapX, uint32 maxTraders, bytes32 indexSourceId, address indexSigner, bytes32 indexRulesHash, uint256 depthNLots, uint256 maxSpreadWad, uint256 bootstrapBandWad, uint64 minOrderLots, uint64 maxOrderLots, uint64 maxLiqLotsPerBlock, bool fundingEnabled))']);

async function main() {
  const [rpc, deploymentPath, rulesPath, engineArg, ...extra] = process.argv.slice(2);
  if (!rpc || !deploymentPath || extra.length || (engineArg && !rulesPath)) throw new Error('BAD_ARGUMENTS');
  const d = parseNativeDeployment(JSON.parse(readFileSync(deploymentPath, 'utf8')));
  const chain = defineChain({ id: Number(d.chainId), name: 'native', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const c = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000, retryCount: 1 }) });
  const checks: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
    c.readContract({ address, abi, functionName, args } as any) as Promise<T>;

  check('chain id', BigInt(await c.getChainId()) === d.chainId);
  const code = await c.getCode({ address: d.outcomeVault });
  check('vault code hash', !!code && same(keccak256(code), d.vaultCodehash));
  check('vault registry', same(await read<string>(d.outcomeVault, VAULT, 'registry'), d.registry));
  check('vault marketId', same(await read<string>(d.outcomeVault, VAULT, 'marketId'), d.marketId));
  check('vault collateral', same(await read<string>(d.outcomeVault, VAULT, 'collateral'), d.collateral));
  check('vault rulesHash', same(await read<string>(d.outcomeVault, VAULT, 'rulesHash'), d.erosRulesHash));
  check('vault scheduledT', await read<bigint>(d.outcomeVault, VAULT, 'scheduledT') === d.scheduledT);
  check('vault issuanceCap', await read<bigint>(d.outcomeVault, VAULT, 'issuanceCap') === d.issuanceCap);
  for (const [side, token, book, isYes] of [['YES', d.yesToken, d.yesBook, true], ['NO', d.noToken, d.noBook, false]] as const) {
    check(`vault ${side} token`, same(await read<string>(d.outcomeVault, VAULT, isYes ? 'yes' : 'no'), token));
    check(`${side} token vault/market/side/decimals`, same(await read<string>(token, TOKEN, 'vault'), d.outcomeVault)
      && same(await read<string>(token, TOKEN, 'marketId'), d.marketId) && await read<boolean>(token, TOKEN, 'isYes') === isYes
      && Number(await read<number>(token, TOKEN, 'decimals')) === 6);
    const p = await read<any[]>(book, BOOK, 'getMarketParams');
    check(`${side} book base/quote/decimals`, same(p[2], token) && same(p[4], d.collateral) && p[3] === 6n && p[5] === 6n,
      `price precision ${p[0]}, size precision ${p[1]}, fees ${p[9]}/${p[10]} bps`);
  }
  const bound = getAddress(await read<string>(d.outcomeVault, VAULT, 'engine'));
  const core = await read<any>(d.registry, REGISTRY, 'getMarketCore', [d.marketId]);
  check('vault bound to registry engine', bound !== '0x0000000000000000000000000000000000000000' && same(core.engine, bound), bound);
  const rules = rulesPath ? parseNativeRules(JSON.parse(readFileSync(rulesPath, 'utf8'))) : undefined;
  const engine = engineArg ? getAddress(engineArg) : bound;
  const indexOnly = !same(engine, bound);
  const marketId = indexOnly ? rules!.marketId : d.marketId;
  if (indexOnly) {
    const perpCore = await read<any>(d.registry, REGISTRY, 'getMarketCore', [marketId]);
    check('perp listed in registry under the rules market id', same(perpCore.engine, engine) && !same(marketId, d.marketId), engine);
  }
  const l = await read<any>(engine, ENGINE, 'listing');
  // An index-only perp has its own rules text; its listing must still match the event's collateral, registry and T.
  check('engine listing (marketId, token, registry, T, rules)', same(l.marketId, marketId) && same(l.token, d.collateral)
    && same(l.registry, d.registry) && BigInt(l.scheduledT) === d.scheduledT && (indexOnly || same(l.rulesHash, d.erosRulesHash)));
  check('engine 1x, funding off', BigInt(l.deploymentCapX) === 1n && l.fundingEnabled === false);
  if (rules) {
    check('native rules bind this deployment', same(rules.kuruOrderBook, d.yesBook) && same(rules.yesToken, d.yesToken)
      && same(rules.noToken, d.noToken) && same(rules.outcomeVault, d.outcomeVault) && same(rules.collateral, d.collateral)
      && same(rules.marketId, marketId) && same(rules.erosRulesHash, d.erosRulesHash) && rules.scheduledT === String(d.scheduledT));
    check('engine pins native source (id, signer, rules hash, depth rule)', same(l.indexSourceId, rules.sourceId)
      && same(l.indexRulesHash, nativeRulesHash(rules)) && String(l.depthNLots) === rules.depthNLots && String(l.maxSpreadWad) === rules.maxSpreadWad,
      `indexSigner ${l.indexSigner}`);
  }
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(json({ engine, checks: checks.length, failed }));
  process.exitCode = failed ? 2 : 0;
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
