import { createHash } from 'node:crypto';
import { normalizeBook, record, summarizeBook } from './book.js';
import type { MarketConfig } from './config.js';
import { sourceTime } from './time.js';
import { uint } from './math.js';

export type MetadataIdentity={rulesDigest:string;tradeable:boolean};
export function outcomeMapping(value:unknown):{labels:string[];tokens:string[]} {
  const m=record(value);let labels:unknown,tokens:unknown;
  try{labels=typeof m.outcomes==='string'?JSON.parse(m.outcomes):m.outcomes;
    tokens=typeof m.clobTokenIds==='string'?JSON.parse(m.clobTokenIds):m.clobTokenIds;
  }catch{throw new Error('BAD_OUTCOME_MAPPING');}
  if(!Array.isArray(labels)||!Array.isArray(tokens)||labels.length!==2||labels.length!==tokens.length
    ||labels.some(x=>typeof x!=='string'||x.length===0)||tokens.some(x=>typeof x!=='string')
    ||new Set(labels).size!==labels.length||new Set(tokens).size!==tokens.length) throw new Error('BAD_OUTCOME_MAPPING');
  for(const token of tokens)uint(token,256);
  return {labels:labels as string[],tokens:tokens as string[]};
}
function metadataSchema(m:Record<string,unknown>,event=false):void {
  uint(m.id,256);
  for(const key of ['resolutionSource','endDate','negRiskMarketID',...(event?['title','description']:[])])
    if(m[key]!==null&&m[key]!==undefined&&typeof m[key]!=='string')throw new Error('BAD_SOURCE_METADATA_SCHEMA');
  for(const key of ['active','closed','negRisk',...(event?['enableNegRisk','negRiskAugmented']:['enableOrderBook','acceptingOrders','negRiskOther'])])
    if(m[key]!==null&&m[key]!==undefined&&typeof m[key]!=='boolean')throw new Error('BAD_SOURCE_METADATA_SCHEMA');
}
/** Separate status evidence: preserve the existing rules digest's encoding. */
export function metadataStatusDigest(eventValue:unknown,marketValue:unknown):string {
  const event=record(eventValue),market=record(marketValue);metadataSchema(event,true);metadataSchema(market);
  const pick=(raw:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.map(key=>[key,raw[key]??null]));
  return createHash('sha256').update(JSON.stringify({event:pick(event,['active','closed','negRisk','enableNegRisk','negRiskAugmented']),
    market:pick(market,['active','closed','enableOrderBook','acceptingOrders','negRisk','negRiskOther'])})).digest('hex');
}
export function metadataIdentity(cfg:MarketConfig,value:unknown):MetadataIdentity {
  const m=record(value);metadataSchema(m);const {labels,tokens}=outcomeMapping(m);
  const index=labels.indexOf(cfg.mapping.outcomeLabel);
  if(String(m.id)!==cfg.mapping.externalMarketId||m.conditionId!==cfg.mapping.conditionId||index<0
      ||tokens[index]!==cfg.mapping.outcomeTokenId)throw new Error('METADATA_IDENTITY_MISMATCH');
  if(typeof m.question!=='string'||typeof m.description!=='string')throw new Error('MISSING_SOURCE_RULES');
  const rulesDigest=createHash('sha256').update(JSON.stringify({question:m.question,description:m.description,
    resolutionSource:m.resolutionSource??null,conditionId:m.conditionId,outcomes:labels,tokens,
    eventId:cfg.mapping.eventId,endDate:m.endDate??null,negRisk:m.negRisk??null,negRiskMarketID:m.negRiskMarketID??null})).digest('hex');
  // Evidence digest only. It is not the Eros indexRulesHash or a mapping approval.
  return {rulesDigest,tradeable:m.active===true&&m.closed===false&&m.enableOrderBook===true&&m.acceptingOrders===true};
}

export function verifyEventMembership(cfg:MarketConfig,value:unknown):MetadataIdentity {
  const event=record(value);metadataSchema(event,true);
  if(event.id!==cfg.mapping.eventId||!Array.isArray(event.markets)
    ||event.markets.filter(m=>record(m).id===cfg.mapping.externalMarketId).length!==1)throw new Error('EVENT_IDENTITY_MISMATCH');
  const member=record(event.markets.find(m=>record(m).id===cfg.mapping.externalMarketId));
  if(member.conditionId!==null&&member.conditionId!==undefined&&member.conditionId!==cfg.mapping.conditionId)
    throw new Error('EVENT_IDENTITY_MISMATCH');
  return {tradeable:event.active===true&&event.closed===false,rulesDigest:createHash('sha256').update(JSON.stringify({
    id:event.id,title:event.title??null,description:event.description??null,resolutionSource:event.resolutionSource??null,
    endDate:event.endDate??null,negRisk:event.negRisk??null,negRiskMarketID:event.negRiskMarketID??null})).digest('hex')};
}

export type Inspection={status:'COLLECTING'|'INVALID_DEPTH'|'DEGRADED'|'QUARANTINED';reason:string|null;
  time:ReturnType<typeof sourceTime>|null;summary:ReturnType<typeof summarizeBook>|null;engineObservation:null};
export function inspectSnapshot(cfg:MarketConfig,value:unknown,receivedAtMs:bigint,lastSourceMs:bigint|null,
  metadata:MetadataIdentity,metadataReceivedAtMs:bigint,expectedRulesDigest?:string):Inspection {
  const result:Inspection={status:'DEGRADED',reason:null,time:null,summary:null,engineObservation:null};
  try {
    const raw=record(value);
    if(raw.market!==cfg.mapping.conditionId||raw.asset_id!==cfg.mapping.outcomeTokenId)throw new Error('BOOK_IDENTITY_MISMATCH');
    if(typeof raw.hash!=='string'||raw.hash.length===0)throw new Error('MISSING_BOOK_HASH');
    if(expectedRulesDigest!==undefined&&metadata.rulesDigest!==expectedRulesDigest)throw new Error('SOURCE_RULES_CHANGED');
    result.time=sourceTime(raw.timestamp,receivedAtMs,lastSourceMs,BigInt(cfg.poll.minimumHeadroomMs));
    result.summary=summarizeBook(normalizeBook(raw),BigInt(cfg.pricing.depthNLots),BigInt(cfg.pricing.maxSpreadWad),cfg.pricing.impactMethod);
    if(!result.time.monotone)throw new Error('BACKWARDS_SOURCE_TIME');
    if(!metadata.tradeable)result.reason='SOURCE_NOT_TRADEABLE';
    else if(receivedAtMs<metadataReceivedAtMs||receivedAtMs-metadataReceivedAtMs>BigInt(cfg.poll.metadataMaxAgeMs))result.reason='STALE_METADATA';
    else if(!result.time.fresh)result.reason='STALE_OR_FUTURE_SOURCE_TIME';
    else if(!result.time.hasHeadroom)result.reason='INSUFFICIENT_HEADROOM';
    else if(!result.summary.valid){result.status='INVALID_DEPTH';result.reason=result.summary.reason;}
    else result.status='COLLECTING';
  } catch(error) {
    result.reason=error instanceof Error?error.message:String(error);
    if(/IDENTITY|RULES_CHANGED|BACKWARDS/.test(result.reason))result.status='QUARANTINED';
  }
  return result;
}
