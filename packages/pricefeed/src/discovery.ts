import { createHash } from 'node:crypto';
import { record } from './book.js';
import type { Category } from './config.js';
import { outcomeMapping } from './collector.js';
import { uint } from './math.js';
import type { Capture } from './polymarket.js';

export type DiscoveryOptions={category:Category;tagSlug:string;pageSize:number;maxPages:number};
export type DiscoveryProvider={tag(slug:string):Promise<Capture>;eventsPage(tagId:string,limit:number,cursor:string|null):Promise<Capture>};
export type DiscoveryCandidate={category:Category;eventId:string;externalMarketId:string;conditionId:string|null;
  title:string|null;question:string|null;description:string|null;resolutionSource:string|null;sourceEndDate:string|null;
  outcomes:{label:string;tokenId:string}[];selectedOutcome:null;enabled:false;mappingApproved:false;
  status:'BLOCKED'|'REVIEW_REQUIRED';reasons:string[];sourcePageSha256:string;sourceEvidenceSha256:string};
const hash=(body:string)=>createHash('sha256').update(body).digest('hex');
const nullableText=(v:unknown)=>typeof v==='string'&&v.length>0?v:null;
function utcDate(value:string|null):boolean {
  if(!value||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))return false;
  const normalized=value.replace(/(?:\.(\d{1,3}))?Z$/,(_match,digits:string|undefined)=>'.'+(digits??'').padEnd(3,'0')+'Z');
  return new Date(value).toISOString()===normalized; // Reject Date.parse's calendar rollover.
}
export function validateDiscoveryOptions(options:DiscoveryOptions):void {
  if(!['sports','politics','crypto'].includes(options.category)||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.tagSlug)
    ||!Number.isSafeInteger(options.pageSize)||options.pageSize<1||options.pageSize>100
    ||!Number.isSafeInteger(options.maxPages)||options.maxPages<1||options.maxPages>20)throw new Error('BAD_DISCOVERY_OPTIONS');
}
function captureData(capture:Capture):Record<string,unknown>{
  // All validation derives from the retained response bytes, not a cached object.
  const raw=record(JSON.parse(capture.body));
  if(JSON.stringify(raw)!==JSON.stringify(capture.data))throw new Error('DISCOVERY_CAPTURE_BODY_DATA_MISMATCH');
  return raw;
}
function candidate(event:Record<string,unknown>,market:Record<string,unknown>,category:Category,tagId:string,pageHash:string):DiscoveryCandidate {
  uint(market.id,256);const reasons:string[]=[];
  const flag=(object:Record<string,unknown>,name:string,expected:boolean,code:string)=>{
    if(typeof object[name]!=='boolean')reasons.push(code+'_UNKNOWN');
    else if(object[name]!==expected)reasons.push(code);
  };
  flag(event,'active',true,'EVENT_INACTIVE');flag(event,'closed',false,'EVENT_CLOSED');
  flag(market,'active',true,'MARKET_INACTIVE');flag(market,'closed',false,'MARKET_CLOSED');
  flag(market,'enableOrderBook',true,'ORDER_BOOK_DISABLED');flag(market,'acceptingOrders',true,'ORDERS_DISABLED');
  flag(event,'negRisk',false,'EVENT_NEGATIVE_RISK_REQUIRES_REVIEW');
  flag(market,'negRisk',false,'NEGATIVE_RISK_REQUIRES_REVIEW');
  // Missing optional flags are retained as unknown, never guessed to be false.
  for(const [object,name,code] of [[event,'negRiskAugmented','AUGMENTED_NEGATIVE_RISK_REQUIRES_REVIEW'],
    [event,'enableNegRisk','NEGATIVE_RISK_EVENT_ENABLED'],[market,'negRiskOther','NEGATIVE_RISK_OTHER_REQUIRES_REVIEW']] as const)
    if(object[name]!==false)reasons.push(typeof object[name]==='boolean'?code:code+'_UNKNOWN');
  if(!Array.isArray(event.tags)||!event.tags.some(t=>t&&typeof t==='object'&&!Array.isArray(t)&&'id' in t&&t.id===tagId))reasons.push('TAG_MEMBERSHIP_UNVERIFIED');
  const conditionId=typeof market.conditionId==='string'&&/^0x[\da-fA-F]{64}$/.test(market.conditionId)?market.conditionId:null;
  if(!conditionId)reasons.push('CONDITION_ID_MISSING_OR_INVALID');
  let outcomes:DiscoveryCandidate['outcomes']=[];
  try{const {labels,tokens}=outcomeMapping(market);outcomes=labels.map((label,i)=>({label,tokenId:tokens[i]!}));}
  catch{reasons.push('OUTCOME_MAPPING_MISSING_OR_INVALID');}
  const question=nullableText(market.question),description=nullableText(market.description),resolutionSource=nullableText(market.resolutionSource);
  if(!question||!description||!resolutionSource)reasons.push('SOURCE_RULES_INCOMPLETE');
  const sourceEndDate=nullableText(market.endDate);
  if(!utcDate(sourceEndDate))
    reasons.push('SOURCE_END_DATE_UNVERIFIED');
  return {category,eventId:event.id as string,externalMarketId:market.id as string,conditionId,
    title:nullableText(event.title),question,description,resolutionSource,sourceEndDate,outcomes,selectedOutcome:null,
    enabled:false,mappingApproved:false,status:reasons.length?'BLOCKED':'REVIEW_REQUIRED',reasons,
    sourcePageSha256:pageHash,sourceEvidenceSha256:hash(JSON.stringify({eventId:event.id,market}))};
}
/** Bounded read-only candidates. Category and tags confer no Eros admission or YES mapping. */
export async function discoverMarkets(provider:DiscoveryProvider,options:DiscoveryOptions){
  validateDiscoveryOptions(options);
  const tagCapture=await provider.tag(options.tagSlug),tag=captureData(tagCapture);uint(tag.id,256);
  if(tag.slug!==options.tagSlug)throw new Error('DISCOVERY_TAG_IDENTITY_MISMATCH');
  const pages:{requestedCursor:string|null;capture:Capture;sha256:string}[]=[],candidates:DiscoveryCandidate[]=[];
  const cursors=new Set<string>(),events=new Set<string>(),markets=new Set<string>(),conditions=new Set<string>(),tokens=new Set<string>();let cursor:string|null=null;
  for(let page=0;page<options.maxPages;page++){
    const capture=await provider.eventsPage(tag.id as string,options.pageSize,cursor),body=captureData(capture);
    if(!Array.isArray(body.events)||body.events.length>options.pageSize)throw new Error('BAD_DISCOVERY_PAGE');
    const pageHash=hash(capture.body);pages.push({requestedCursor:cursor,capture,sha256:pageHash});
    for(const value of body.events){
      const event=record(value);uint(event.id,256);
      if(events.has(event.id as string))throw new Error('DISCOVERY_DUPLICATE_EVENT');events.add(event.id as string);
      if(!Array.isArray(event.markets)||event.markets.length>1000)throw new Error('BAD_DISCOVERY_EVENT');
      for(const item of event.markets){
        const market=record(item);uint(market.id,256);
        if(markets.has(market.id as string))throw new Error('DISCOVERY_DUPLICATE_MARKET');markets.add(market.id as string);
        if(candidates.length>=5000)throw new Error('DISCOVERY_CANDIDATE_LIMIT');
        const found=candidate(event,market,options.category,tag.id as string,pageHash);
        if(found.conditionId){
          const condition=found.conditionId.toLowerCase();
          if(conditions.has(condition))throw new Error('DISCOVERY_DUPLICATE_CONDITION');conditions.add(condition);
        }
        for(const outcome of found.outcomes){
          if(tokens.has(outcome.tokenId))throw new Error('DISCOVERY_DUPLICATE_TOKEN');tokens.add(outcome.tokenId);
        }
        candidates.push(found);
      }
    }
    const next=body.next_cursor;
    if(next!==null&&next!==undefined&&next!==''&&(typeof next!=='string'||next.length>8192||/\s/.test(next)))throw new Error('BAD_DISCOVERY_CURSOR');
    cursor=typeof next==='string'&&next.length>0?next:null;
    if(cursor===null)break;
    if(cursors.has(cursor)||body.events.length===0)throw new Error('DISCOVERY_PAGINATION_STALLED');cursors.add(cursor);
  }
  return {mode:'READ_ONLY_MARKET_DISCOVERY',schemaVersion:'1',providerSchema:'GAMMA_EVENTS_KEYSET_V1',options:structuredClone(options),
    tag:{id:tag.id as string,slug:options.tagSlug,label:nullableText(tag.label),capture:tagCapture,sha256:hash(tagCapture.body)},pages,candidates,
    scanComplete:cursor===null,nextCursor:cursor,stopReason:cursor===null?'END_OF_SCAN':'MAX_PAGES',
    signaturesProduced:0,transactionsSent:0,configurationsActivated:0,productionApproved:false,
    limitations:['Candidates require explicit payoff/deadline/exception and Eros listing review; no outcome is selected automatically.',
      'Source endDate is evidence and never replaces Eros scheduledT. Liquidity/freshness/terms/calibration are not certified by discovery.']};
}
