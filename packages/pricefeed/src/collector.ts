import { createHash } from 'node:crypto';
import { normalizeBook, record, summarizeBook } from './book.js';
import type { MarketConfig } from './config.js';
import { sourceTime } from './time.js';

export type MetadataIdentity={rulesDigest:string;tradeable:boolean};
export function metadataIdentity(cfg:MarketConfig,value:unknown):MetadataIdentity {
  const m=record(value);
  const labels=typeof m.outcomes==='string'?JSON.parse(m.outcomes):m.outcomes;
  const tokens=typeof m.clobTokenIds==='string'?JSON.parse(m.clobTokenIds):m.clobTokenIds;
  if(!Array.isArray(labels)||!Array.isArray(tokens)||labels.length!==2||labels.length!==tokens.length
    ||labels.some(x=>typeof x!=='string')||tokens.some(x=>typeof x!=='string')||new Set(labels).size!==labels.length) throw new Error('BAD_OUTCOME_MAPPING');
  const index=labels.indexOf(cfg.mapping.outcomeLabel);
  if(String(m.id)!==cfg.mapping.externalMarketId||m.conditionId!==cfg.mapping.conditionId||index<0
      ||tokens[index]!==cfg.mapping.outcomeTokenId)throw new Error('METADATA_IDENTITY_MISMATCH');
  if(typeof m.question!=='string'||typeof m.description!=='string')throw new Error('MISSING_SOURCE_RULES');
  const rulesDigest=createHash('sha256').update(JSON.stringify({question:m.question,description:m.description,
    resolutionSource:m.resolutionSource??null,conditionId:m.conditionId,outcomes:labels,tokens})).digest('hex');
  // Evidence digest only. It is not the Eros indexRulesHash or a mapping approval.
  return {rulesDigest,tradeable:m.active===true&&m.closed===false&&m.enableOrderBook===true&&m.acceptingOrders===true};
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
