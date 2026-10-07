/** Qualify the explicitly selected public testnet source without signing. */
import './source-dns.mjs';
import { SourceQualification, QUALIFICATION_DURATION_MS, QUALIFICATION_STARTUP_ALLOWANCE_MS } from './source-qualification.mjs';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Journal } from '../../packages/pricefeed/dist/src/journal.js';
import { Worker } from '../../packages/pricefeed/dist/src/worker.js';
import { PublicPolymarket, RequestLimiter } from '../../packages/pricefeed/dist/src/polymarket.js';
import { metadataIdentity, verifyEventMembership } from '../../packages/pricefeed/dist/src/collector.js';
import { DEVELOPMENT_INVALID_POLICIES } from '../../packages/pricefeed/dist/src/publication.js';
import { PRICING_POLICY, rulesHash } from '../../packages/pricefeed/dist/src/rules.js';
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { keccak256, stringToHex } = require('viem');
const [directory] = process.argv.slice(2);
if (!directory?.startsWith('tmp/')) throw Error('IGNORED_RUN_DIRECTORY_REQUIRED');
const read = name => JSON.parse(fs.readFileSync(`${directory}/${name}`, 'utf8'));
const write = (name, value) => fs.writeFileSync(`${directory}/${name}`, JSON.stringify(value, (_,v)=>typeof v==='bigint'?v.toString():v, 2)+'\n', { mode:0o600 });
const market = read('metadata.json'), event = read('event.json');
const selected = read('selected-market.json');
// This is a reviewed named YES token in an augmented event, not an Other token
// or a conversion strategy. Keep automatic discovery's conservative gates intact.
if (market.id !== selected.id || market.negRiskOther === true
  || market.conditionId !== selected.conditionId || market.question !== selected.question
  || !['crypto','politics','sports'].includes(selected.category)) throw Error('SELECTED_SOURCE_CHANGED');
const horizon=Date.parse(market.endDate)-Date.now();
if(horizon<25*3600000||horizon>29*86400000)throw Error('SOURCE_OUTSIDE_DEPLOYED_HORIZON');
const labels=JSON.parse(market.outcomes),tokens=JSON.parse(market.clobTokenIds),label=selected.outcomeLabel??'Yes',yes=labels.indexOf(label);
if(labels.length!==2||new Set(labels).size!==2||yes<0||tokens[yes]!==selected.yesTokenId)throw Error('YES_MAPPING_CHANGED');
const config=JSON.parse(fs.readFileSync('artifacts/deployments/monad-testnet-20261006/services/pricefeed-config.json','utf8'));
config.key=`live-${market.id}`;config.configVersion='monad-replacement-demo-1';config.category=selected.category;config.destination=null;
// Multi-market sporting events can exceed 1 MB. Keep the supported 2 MB bound.
config.poll.bodyLimitBytes=2000000;
config.mapping={eventId:event.id,externalMarketId:market.id,conditionId:market.conditionId,outcomeTokenId:tokens[yes],outcomeLabel:label};
config.requiredFeedUntil=String(Math.floor(Date.parse(market.endDate)/1000));
const hash=s=>keccak256(stringToHex(s));
const rules={schemaVersion:'1',venue:'polymarket',...config.mapping,marketId:hash(`PENDING_TESTNET_MARKET:${market.id}:${tokens[yes]}`),
  sourceId:hash(`EROS_POLYMARKET_INDEX_V1:${market.conditionId}:${tokens[yes]}`),erosRulesHash:hash(market.description),
  externalRulesDigest:'0x'+createHash('sha256').update(`${verifyEventMembership(config,event).rulesDigest}:${metadataIdentity(config,market).rulesDigest}`).digest('hex'),
  ...DEVELOPMENT_INVALID_POLICIES,scheduledT:config.requiredFeedUntil,depthNLots:config.pricing.depthNLots,maxSpreadWad:config.pricing.maxSpreadWad,pricingPolicy:PRICING_POLICY};
const source={mode:'MONAD_TESTNET_EXTERNAL_SOURCE',schemaVersion:1,chainId:10143,marketId:rules.marketId,sourceId:rules.sourceId,
  sourceRulesHash:rulesHash(rules),scheduledT:rules.scheduledT,depthNLots:rules.depthNLots,maxSpreadWad:rules.maxSpreadWad,
  question:market.question,description:market.description,resolutionSource:market.resolutionSource??null,config,rules,
  preparedAtMs:String(Date.now()),productionApproved:false,calibration:'SYNTHETIC_TEST_RISK_PARAMETERS_NOT_EMPIRICAL',
  namedOutcomeReview:{marketId:market.id,label:market.groupItemTitle,negativeRisk:market.negRisk,eventAugmented:event.negRiskAugmented??null,
    scope:'Exact named binary YES-token order book and eventual finalized binary payout only; no outcome conversions, Other or placeholders.',
    reference:'https://docs.polymarket.com/concepts/negative-risk'}};
write('source-candidate.json',source);
const journalPath=`${directory}/qualification.sqlite`;
if(fs.existsSync(journalPath))throw Error('QUALIFICATION_ALREADY_EXISTS');
const journal=new Journal(journalPath),worker=new Worker(config,new PublicPolymarket(config.poll,new RequestLimiter(100,200)),journal,randomUUID());
const start = Date.now();
const qualification = new SourceQualification({ startedAtMs: start,
  externalRulesDigest: source.rules.externalRulesDigest, minimumHeadroomMs: config.poll.minimumHeadroomMs });
const deadline = start + QUALIFICATION_DURATION_MS + QUALIFICATION_STARTUP_ALLOWANCE_MS;
const save = complete => {
  const result = { ...qualification.snapshot(complete, Date.now()), sourceId: source.sourceId,
    externalMarketId: config.mapping.externalMarketId, conditionId: config.mapping.conditionId,
    outcomeTokenId: config.mapping.outcomeTokenId };
  write('source-qualification.json', result); console.log(JSON.stringify(result)); return result;
};
try {
  // Require fifteen minutes from the first valid receipt, excluding cold startup.
  // The startup allowance bounds the run; a delayed first poll cannot shorten proof.
  while (Date.now() < deadline && !qualification.durationComplete(Date.now())) {
    const tick = Date.now(), result = await worker.poll();
    qualification.observe(result, Date.now());
    if (qualification.count % 30 === 0) save(false);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 - (Date.now() - tick))));
  }
  const result = save(true);
  if (result.passed) { source.probe = result; write('source-qualified.json', source); }
  else { console.error('CONTINUOUS_SOURCE_QUALIFICATION_FAILED'); process.exitCode = 1; }
} catch (error) {
  qualification.fail(); save(false); console.error(error.message); process.exitCode = 1;
} finally { worker.releaseLease(); journal.close(); }
