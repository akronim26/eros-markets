import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { keccak256, stringToHex } from 'viem';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { parseConfig, type MarketConfig } from '../src/config.js';
import { DEVELOPMENT_INVALID_POLICIES } from '../src/publication.js';
import { PRICING_POLICY, rulesHash, type RulesManifest } from '../src/rules.js';
import type { Capture } from '../src/polymarket.js';
import type { Provider } from '../src/worker.js';

export const LOCAL_INDEX_SIGNER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
export const LOCAL_MARKETS = ['demo', 'terminal'] as const;
export type LocalMarket = typeof LOCAL_MARKETS[number];
export type FixtureMode = 'valid' | 'stale' | 'missing-time' | 'thin' | 'outage';
const hash = (value: string) => keccak256(stringToHex(value));

export function requireLoopback(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash || url.search || url.pathname !== '/') {
    throw new Error('LOCAL_LOOPBACK_RPC_REQUIRED');
  }
}

export function localSourceConfig(market: LocalMarket): MarketConfig {
  return parseConfig({
    schemaVersion: '1', configVersion: 'local-real-factory-fixture-1', key: `local-factory-${market}`,
    category: 'crypto', enabled: false, destination: null,
    mapping: { eventId: '1', externalMarketId: '2', conditionId: hash('EROS_LOCAL_FIXTURE_CONDITION_V1'),
      outcomeTokenId: '3', outcomeLabel: 'Yes' },
    pricing: { depthNLots: '1000', maxSpreadWad: '50000000000000000', impactMethod: 'vwap' },
    policies: { timestampPolicyId: 'local-fixture-virtual-clock', quantityPolicyId: 'local-fixture-claims',
      quotePolicyId: 'local-fixture-no-conversion', mappingApprovalId: null, pricingApprovalId: null,
      timeApprovalId: null, rulesApprovalId: null, unitsApprovalId: null, invalidApprovalId: null, operatingApprovalId: null },
    requiredFeedUntil: null,
    poll: { intervalMs: 100, timeoutMs: 2000, maxRetries: 0, retryDelayMs: 0, metadataMaxAgeMs: 90000,
      minimumHeadroomMs: 1000, bodyLimitBytes: 100000 },
  });
}

export function fixtureMetadata(config: MarketConfig): Record<string, unknown> {
  return { id: config.mapping.externalMarketId, conditionId: config.mapping.conditionId,
    outcomes: ['Yes', 'No'], clobTokenIds: [config.mapping.outcomeTokenId, '4'],
    question: 'Local integration fixture resolves YES', description: 'Synthetic localhost source; not a real event or live price.',
    active: true, closed: false, enableOrderBook: true, acceptingOrders: true };
}

export function fixtureEvent(config: MarketConfig): Record<string, unknown> {
  return { id: config.mapping.eventId, markets: [{ id: config.mapping.externalMarketId }], active: true, closed: false };
}

export function localFactoryFixture(scheduledT: bigint) {
  if (scheduledT < 86400n || scheduledT >= 1n << 64n) throw new Error('BAD_LOCAL_HALT_TIME');
  const sourceId = hash('EROS_LOCAL_FIXTURE_INDEX_V1');
  const markets = Object.fromEntries(LOCAL_MARKETS.map(market => {
    const config = localSourceConfig(market);
    const externalRulesDigest = '0x' + createHash('sha256').update(
      `${verifyEventMembership(config, fixtureEvent(config)).rulesDigest}:${metadataIdentity(config, fixtureMetadata(config)).rulesDigest}`,
    ).digest('hex');
    const rules: RulesManifest = { schemaVersion: '1', venue: 'polymarket', ...config.mapping,
      marketId: hash(`EROS_LOCAL_FACTORY_${market.toUpperCase()}_V1`), sourceId,
      erosRulesHash: hash('LOCAL FIXTURE ONLY: scripted committee YES; no external-world factual claim.'), externalRulesDigest,
      ...DEVELOPMENT_INVALID_POLICIES, scheduledT: scheduledT.toString(),
      depthNLots: config.pricing.depthNLots, maxSpreadWad: config.pricing.maxSpreadWad, pricingPolicy: PRICING_POLICY };
    return [market, { marketId: rules.marketId, sourceRulesHash: rulesHash(rules), config, rules }];
  })) as Record<LocalMarket, { marketId: string; sourceRulesHash: string; config: MarketConfig; rules: RulesManifest }>;
  return { mode: 'LOCAL_FIXTURE_ONLY', chainId: 31337, scheduledT: scheduledT.toString(), sourceId,
    indexSigner: LOCAL_INDEX_SIGNER, productionApproved: false, markets };
}

export async function startFixtureSource(now: () => bigint) {
  const modes: Record<LocalMarket, FixtureMode> = { demo: 'valid', terminal: 'valid' };
  const frozenTimes: Partial<Record<LocalMarket, bigint>> = {};
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const parts = (request.url ?? '').split('/');
    const market = parts[1] as LocalMarket;
    const resource = parts[2];
    if (request.method !== 'GET' || !LOCAL_MARKETS.includes(market) || !['event', 'metadata', 'book'].includes(resource ?? '')) {
      response.writeHead(404); response.end(); return;
    }
    if (modes[market] === 'outage') { response.writeHead(503); response.end('fixture outage'); return; }
    const config = localSourceConfig(market);
    const payload = resource === 'event' ? fixtureEvent(config) : resource === 'metadata' ? fixtureMetadata(config) : {
      market: config.mapping.conditionId, asset_id: config.mapping.outcomeTokenId,
      ...(modes[market] === 'missing-time' ? {} : { timestamp: String(frozenTimes[market] ?? now()) }),
      hash: `local-fixture-${market}-${now()}`, tick_size: '0.01', min_order_size: '0.001',
      bids: [{ price: '0.49', size: modes[market] === 'thin' ? '0.001' : '10000' }],
      asks: [{ price: '0.51', size: '10000' }],
    };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL_FIXTURE_PORT_MISSING');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const provider = (market: LocalMarket): Provider => {
    const capture = async (resource: string): Promise<Capture> => {
      const url = `${endpoint}/${market}/${resource}`;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`FIXTURE_HTTP_${response.status}`);
      const body = await response.text();
      return { url, receivedAtMs: now(), latencyMs: 0n, body, data: JSON.parse(body), headers: {}, attempts: 1 };
    };
    return { event: async () => capture('event'), metadata: async () => capture('metadata'), book: async () => capture('book') };
  };
  return { endpoint, provider, requestCount: () => requests,
    setMode(market: LocalMarket, mode: FixtureMode) {
      modes[market] = mode;
      if (mode === 'stale') frozenTimes[market] = now();
      else delete frozenTimes[market];
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
