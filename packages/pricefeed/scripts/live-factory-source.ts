import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, stringToHex } from 'viem';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { parseConfig, type Category, type MarketConfig } from '../src/config.js';
import { discoverMarkets, type DiscoveryCandidate } from '../src/discovery.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { DEVELOPMENT_INVALID_POLICIES } from '../src/publication.js';
import { PRICING_POLICY, parseRules, rulesHash, type RulesManifest } from '../src/rules.js';
import { Worker, type PollResult } from '../src/worker.js';
import { LOCAL_INDEX_SIGNER } from './local-factory-fixture.js';
import { checkLiveClock } from './live-clock.js';

const hash = (value: string) => keccak256(stringToHex(value));
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const LIVE_EROS_RULES_PREFIX = 'LOCAL DIAGNOSTIC: external price mapping only; adjudication is a controlled fixture. ';
export const LIVE_POLL = { intervalMs: 1000, timeoutMs: 4000, maxRetries: 1, retryDelayMs: 200,
  metadataMaxAgeMs: 90000, minimumHeadroomMs: 5000, bodyLimitBytes: 1000000 };
export type LiveSource = {
  mode: 'LOCAL_LIVE_SOURCE_DIAGNOSTIC'; schemaVersion: 1; chainId: 31337;
  marketId: string; sourceId: string; sourceRulesHash: string; indexSigner: string;
  scheduledT: string; depthNLots: string; maxSpreadWad: string; question: string;
  description: string; resolutionSource: string | null; sourceHash: string; erosRulesHash: string;
  config: MarketConfig; rules: RulesManifest; preparedAtMs: string;
  probe: { durationMs: number; captures: number; advances: number; maximumAdvanceGapMs: string };
  productionApproved: false; calibration: 'SYNTHETIC_TEST_RISK_PARAMETERS_NOT_EMPIRICAL';
};

export function sourceConfig(candidate: DiscoveryCandidate): MarketConfig {
  const yes = candidate.outcomes.find(outcome => outcome.label.toLowerCase() === 'yes');
  if (!candidate.conditionId || !yes || candidate.outcomes.length !== 2
      || !candidate.outcomes.some(outcome => outcome.label.toLowerCase() === 'no')) throw new Error('LIVE_BINARY_YES_NO_REQUIRED');
  return parseConfig({ schemaVersion: '1', configVersion: 'live-full-engine-local-1',
    key: `live-${candidate.externalMarketId}`, category: candidate.category, enabled: false, destination: null,
    mapping: { eventId: candidate.eventId, externalMarketId: candidate.externalMarketId,
      conditionId: candidate.conditionId, outcomeTokenId: yes.tokenId, outcomeLabel: yes.label },
    pricing: { depthNLots: '1000000', maxSpreadWad: '50000000000000000', impactMethod: 'vwap' },
    policies: { timestampPolicyId: 'authentic-vendor-ms-floor-diagnostic', quantityPolicyId: 'claims-floor-total-diagnostic',
      quotePolicyId: 'before-fee-vwap-unapproved', mappingApprovalId: null, pricingApprovalId: null,
      timeApprovalId: null, rulesApprovalId: null, unitsApprovalId: null, invalidApprovalId: null, operatingApprovalId: null },
    requiredFeedUntil: null, poll: LIVE_POLL });
}

export function candidateEligible(candidate: DiscoveryCandidate, nowMs: number): boolean {
  const end = Date.parse(candidate.sourceEndDate ?? '');
  if (!Number.isFinite(end) || end - nowMs < 25 * 3600000 || end - nowMs > 29 * 86400000
    || !candidate.question || !candidate.description) return false;
  // Missing optional negative-risk flags are retained in discovery evidence. Only explicit
  // negative-risk status, incomplete identity/rules or disabled books reject diagnostics here.
  if (candidate.reasons.some(reason => !reason.endsWith('_UNKNOWN') && reason !== 'SOURCE_RULES_INCOMPLETE')) return false;
  try { sourceConfig(candidate); return true; } catch { return false; }
}

export function probeSummary(results: readonly PollResult[], durationMs: number): LiveSource['probe'] {
  if (durationMs < 120000 || results.length < 20) throw new Error('LIVE_PROBE_TOO_SHORT');
  let previous: bigint | null = null, advances = 0, maximum = 0n;
  for (const result of results) {
    const inspection = result.inspection, time = inspection.time;
    if (inspection.status !== 'COLLECTING' || !time || !inspection.summary?.priceWad
      || inspection.summary.priceWad < 100000000000000000n || inspection.summary.priceWad > 900000000000000000n)
      throw new Error(`LIVE_PROBE_UNSUITABLE:${inspection.reason ?? 'PRICE_NOT_INTERIOR'}`);
    if (result.atMs - time.sourceMs > 20000n || result.atMs < time.sourceMs) throw new Error('LIVE_PROBE_SOURCE_AGE');
    if (previous !== null && time.sourceMs > previous) {
      const gap = time.sourceMs - previous; if (gap > maximum) maximum = gap; ++advances;
    }
    previous = time.sourceMs;
  }
  if (advances < 6 || maximum > 20000n) throw new Error('LIVE_PROBE_SOURCE_CLOCK_TOO_QUIET');
  return { durationMs, captures: results.length, advances, maximumAdvanceGapMs: maximum.toString() };
}

export function createLiveSource(candidate: DiscoveryCandidate, config: MarketConfig,
  result: PollResult, probe: LiveSource['probe'], preparedAtMs = BigInt(Date.now()), identity = randomUUID()): LiveSource {
  if (!candidateEligible(candidate, Number(preparedAtMs)) || !result.metadata || !result.event)
    throw new Error('LIVE_SOURCE_NO_LONGER_ELIGIBLE');
  const scheduledT = String(Math.floor(Date.parse(candidate.sourceEndDate!) / 1000));
  const sourceId = hash(`EROS_POLYMARKET_INDEX_V1:${config.mapping.conditionId}:${config.mapping.outcomeTokenId}`);
  const marketId = hash(`EROS_LOCAL_LIVE_ENGINE_V1:${identity}:${sourceId}`);
  const sourceHash = hash(json({ question: candidate.question, description: candidate.description,
    resolutionSource: candidate.resolutionSource, mapping: config.mapping, scheduledT }));
  const erosRulesHash = hash(LIVE_EROS_RULES_PREFIX + candidate.description);
  const externalRulesDigest = '0x' + createHash('sha256').update(
    `${verifyEventMembership(config, result.event.data).rulesDigest}:${metadataIdentity(config, result.metadata.data).rulesDigest}`).digest('hex');
  const rules: RulesManifest = { schemaVersion: '1', venue: 'polymarket', ...config.mapping, marketId, sourceId,
    erosRulesHash, externalRulesDigest, ...DEVELOPMENT_INVALID_POLICIES, scheduledT,
    ...config.pricing, pricingPolicy: PRICING_POLICY } as RulesManifest;
  // pricing.impactMethod belongs to MarketConfig, not the immutable rules wire format.
  delete (rules as unknown as Record<string, unknown>).impactMethod;
  return { mode: 'LOCAL_LIVE_SOURCE_DIAGNOSTIC', schemaVersion: 1, chainId: 31337,
    marketId, sourceId, sourceRulesHash: rulesHash(rules), indexSigner: LOCAL_INDEX_SIGNER,
    scheduledT, depthNLots: config.pricing.depthNLots, maxSpreadWad: config.pricing.maxSpreadWad,
    question: candidate.question!, description: candidate.description!, resolutionSource: candidate.resolutionSource,
    sourceHash, erosRulesHash, config: { ...config, requiredFeedUntil: scheduledT }, rules,
    preparedAtMs: preparedAtMs.toString(), probe, productionApproved: false,
    calibration: 'SYNTHETIC_TEST_RISK_PARAMETERS_NOT_EMPIRICAL' };
}

export function readLiveSource(path: string): LiveSource {
  const value = JSON.parse(readFileSync(path, 'utf8')) as LiveSource;
  if (value.mode !== 'LOCAL_LIVE_SOURCE_DIAGNOSTIC' || value.chainId !== 31337 || value.schemaVersion !== 1
    || value.productionApproved !== false || value.indexSigner !== LOCAL_INDEX_SIGNER) throw new Error('LIVE_SOURCE_MANIFEST_REQUIRED');
  value.config = parseConfig(value.config); value.rules = parseRules(value.rules);
  if (value.config.enabled || value.config.destination !== null || rulesHash(value.rules) !== value.sourceRulesHash
    || value.rules.marketId !== value.marketId || value.rules.sourceId !== value.sourceId
    || value.rules.scheduledT !== value.scheduledT || value.rules.erosRulesHash !== value.erosRulesHash
    || value.rules.depthNLots !== value.depthNLots || value.rules.maxSpreadWad !== value.maxSpreadWad
    || value.config.pricing.depthNLots !== value.depthNLots || value.config.pricing.maxSpreadWad !== value.maxSpreadWad)
    throw new Error('LIVE_SOURCE_MANIFEST_CHANGED');
  for (const [name, expected] of Object.entries(value.config.mapping))
    if (value.rules[name as keyof RulesManifest] !== expected) throw new Error('LIVE_SOURCE_MAPPING_CHANGED');
  const sourceHash = hash(json({ question: value.question, description: value.description,
    resolutionSource: value.resolutionSource, mapping: value.config.mapping, scheduledT: value.scheduledT }));
  if (sourceHash !== value.sourceHash || value.erosRulesHash !== hash(LIVE_EROS_RULES_PREFIX + value.description))
    throw new Error('LIVE_SOURCE_METADATA_CHANGED');
  return value;
}

export async function validateLiveSource(path: string, directory: string, output: string, fullProbe = false): Promise<void> {
  const clockPreflight = join(directory, `clock-${Date.now()}.json`);
  await checkLiveClock(clockPreflight);
  const source = readLiveSource(path), end = BigInt(source.scheduledT), now = BigInt(Math.floor(Date.now() / 1000));
  if (end - now < 25n * 3600n || end - now > 29n * 86400n) throw new Error('LIVE_SOURCE_HORIZON_OUTSIDE_PREFLIGHT');
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, `preflight-${Date.now()}.sqlite`);
  if (existsSync(output)) throw new Error('LIVE_PREFLIGHT_OUTPUT_ALREADY_EXISTS');
  const journal = new Journal(archive);
  const worker = new Worker(source.config, new PublicPolymarket(source.config.poll, new RequestLimiter(100, 20)), journal, randomUUID());
  try {
    const beginning = Date.now(), results: PollResult[] = [];
    let result: PollResult, digest: string;
    do {
    const tick = Date.now(); result = await worker.poll(); results.push(result);
    if (result.inspection.status !== 'COLLECTING' || !result.metadata || !result.event) throw new Error(`LIVE_PREFLIGHT_SOURCE_UNAVAILABLE:${result.inspection.reason}`);
    digest = '0x' + createHash('sha256').update(`${verifyEventMembership(source.config, result.event.data).rulesDigest}:${metadataIdentity(source.config, result.metadata.data).rulesDigest}`).digest('hex');
    if (digest !== source.rules.externalRulesDigest) throw new Error('LIVE_PREFLIGHT_SOURCE_RULES_CHANGED');
    if (fullProbe) await pause(Math.max(1, source.config.poll.intervalMs - (Date.now() - tick)));
    } while (fullProbe && Date.now() - beginning < 120000);
    const probe = fullProbe ? probeSummary(results, Date.now() - beginning) : null;
    writeFileSync(output, json({ mode: 'LIVE_SOURCE_PREFLIGHT', passed: true, source: path,
      marketId: source.marketId, archive, clockPreflight, sourceMs: result.inspection.time?.sourceMs,
      priceWad: result.inspection.summary?.priceWad, externalRulesDigest: digest, probe,
      checkedAtMs: String(Date.now()), transactionsSent: 0 }) + '\n', { flag: 'wx' });
  } finally { worker.releaseLease(); journal.close(); }
}

export async function prepareLiveSource(directory: string, output: string): Promise<void> {
  await checkLiveClock(join(directory, `clock-${Date.now()}.json`));
  if (existsSync(output)) throw new Error('LIVE_SOURCE_OUTPUT_ALREADY_EXISTS');
  mkdirSync(directory, { recursive: true });
  const journalPath = join(directory, 'probe.sqlite');
  if (existsSync(journalPath)) throw new Error('LIVE_PROBE_ALREADY_EXISTS');
  const limiter = new RequestLimiter(100, 200);
  const journal = new Journal(journalPath), provider = new PublicPolymarket(LIVE_POLL, limiter);
  const discoveryProvider = new PublicPolymarket({ ...LIVE_POLL, bodyLimitBytes: 8000000 }, limiter);
  const rejected: unknown[] = [], candidates: DiscoveryCandidate[] = [];
  let lastWorker: Worker | undefined;
  try {
    for (const category of ['crypto', 'politics', 'sports'] as Category[]) {
      try {
        const discovery = await discoverMarkets({ tag: slug => discoveryProvider.tag(slug),
          eventsPage: (tagId, limit, cursor) => {
            const url = new URL('https://gamma-api.polymarket.com/events/keyset');
            for (const [name, value] of Object.entries({ closed: 'false', limit: String(limit), tag_id: tagId,
              order: 'volume24hr', ascending: 'false' })) url.searchParams.set(name, value);
            if (cursor) url.searchParams.set('after_cursor', cursor);
            return discoveryProvider.request(url.href);
        } }, { category, tagSlug: category, pageSize: 5, maxPages: 4 });
        writeFileSync(join(directory, `discovery-${category}.json`), json(discovery) + '\n', { flag: 'wx' });
        candidates.push(...discovery.candidates.filter(candidate => candidateEligible(candidate, Date.now())));
      } catch (error) {
        const failure = { category, reason: error instanceof Error ? error.message : String(error) };
        rejected.push(failure); writeFileSync(join(directory, `discovery-${category}-failure.json`), json(failure) + '\n', { flag: 'wx' });
      }
    }
    // Round-robin event ladders so one large event cannot consume the whole probe budget.
    const groups = new Map<string, DiscoveryCandidate[]>();
    for (const candidate of candidates) { const group = groups.get(candidate.eventId) ?? []; group.push(candidate); groups.set(candidate.eventId, group); }
    const diversified: DiscoveryCandidate[] = [];
    while ([...groups.values()].some(group => group.length)) for (const group of groups.values()) {
      const candidate = group.shift(); if (candidate) diversified.push(candidate);
    }
    const screened: { candidate: DiscoveryCandidate; distance: bigint; sourceAge: bigint }[] = [];
    for (const candidate of diversified.slice(0, 50)) {
      const worker = new Worker(sourceConfig(candidate), provider, journal, randomUUID());
      try {
        const result = await worker.poll(), price = result.inspection.summary?.priceWad;
        if (result.inspection.status === 'COLLECTING' && price && price >= 100000000000000000n
          && price <= 900000000000000000n && result.inspection.time) {
          screened.push({ candidate, distance: price > 500000000000000000n ? price - 500000000000000000n : 500000000000000000n - price,
            sourceAge: result.atMs - result.inspection.time.sourceMs });
        } else rejected.push({ market: candidate.externalMarketId, phase: 'screen', reason: result.inspection.reason ?? 'PRICE_NOT_INTERIOR' });
      } finally { worker.releaseLease(); }
    }
    screened.sort((a, b) => a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : a.sourceAge < b.sourceAge ? -1 : 1);
    writeFileSync(join(directory, 'screened.json'), json(screened) + '\n', { flag: 'wx' });
    const qualified = await Promise.all(screened.slice(0, 8).map(async ({ candidate }) => {
      const config = sourceConfig(candidate), worker = new Worker(config, provider, journal, randomUUID());
      const results: PollResult[] = []; const beginning = Date.now();
      try {
        do {
          const tick = Date.now(), result = await worker.poll(); results.push(result);
          const p = result.inspection.summary?.priceWad;
          if (result.inspection.status !== 'COLLECTING' || !p || p < 100000000000000000n || p > 900000000000000000n
              || !result.inspection.time || result.atMs - result.inspection.time.sourceMs > 20000n)
            throw new Error(`LIVE_PROBE_UNSUITABLE:${result.inspection.reason ?? 'PRICE_OR_AGE'}`);
          console.log(json({ mode: 'LIVE_SOURCE_PROBE', market: candidate.externalMarketId,
            elapsedMs: Date.now() - beginning, sourceMs: result.inspection.time.sourceMs, priceWad: p }));
          await pause(Math.max(1, config.poll.intervalMs - (Date.now() - tick)));
        } while (Date.now() - beginning < 120000);
        const probe = probeSummary(results, Date.now() - beginning);
        return { candidate, source: createLiveSource(candidate, config, results.at(-1)!, probe) };
      } catch (error) {
        rejected.push({ market: candidate.externalMarketId, reason: error instanceof Error ? error.message : String(error), captures: results.length });
        writeFileSync(join(directory, 'rejections.json'), json(rejected) + '\n');
        return null;
      } finally { worker.releaseLease(); }
    }));
    const selected = qualified.find(value => value !== null);
    if (selected) {
      const { candidate, source } = selected;
      writeFileSync(output, json(source) + '\n', { flag: 'wx' });
      writeFileSync(join(directory, 'selection.json'), json({ selected: candidate, probe: source.probe, rejected,
        qualified: qualified.filter(value => value !== null).map(value => ({ candidate: value.candidate, probe: value.source.probe })) }) + '\n', { flag: 'wx' });
      console.log(json({ mode: 'LIVE_SOURCE_PREPARED', output, marketId: source.marketId,
        sourceId: source.sourceId, scheduledT: source.scheduledT, probe: source.probe }));
      return;
    }
    throw new Error(`LIVE_SOURCE_NO_SUITABLE_CANDIDATE:${candidates.length}`);
  } finally { lastWorker?.releaseLease(); journal.close(); }
}
