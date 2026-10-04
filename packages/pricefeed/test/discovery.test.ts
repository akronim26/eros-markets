import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { discoverMarkets, type DiscoveryOptions } from '../src/discovery.js';
import { PublicPolymarket, RequestLimiter, type Capture } from '../src/polymarket.js';
import { config } from './publication-fixture.js';
import { metadataIdentity, outcomeMapping, verifyEventMembership } from '../src/collector.js';
import type { Category } from '../src/config.js';

const options:DiscoveryOptions={category:'sports',tagSlug:'sports',pageSize:2,maxPages:3};
const market=(id:string)=>({id,question:'Team A wins?',description:'Fixture outcome and exception rules',resolutionSource:'Official fixture source',
  conditionId:'0x'+BigInt(id).toString(16).padStart(64,'0'),endDate:'2027-01-01T00:00:00Z',
  outcomes:'["Team A","Team B"]',clobTokenIds:JSON.stringify([String(BigInt(id)*2n),String(BigInt(id)*2n+1n)]),
  active:true,closed:false,enableOrderBook:true,acceptingOrders:true,negRisk:false,negRiskOther:false});
const event=(id:string,m=market(id))=>({id,title:'Fixture event',markets:[m],tags:[{id:'1'}],active:true,closed:false,
  negRisk:false,negRiskAugmented:false,enableNegRisk:false});
const capture=(data:Record<string,unknown>):Capture=>({url:'https://gamma-api.polymarket.com/events/keyset',body:JSON.stringify(data),data,
  receivedAtMs:1000100n,latencyMs:1n,headers:{},attempts:1});
function fixture(pages:Record<string,unknown>[],opts=options){
  const calls:{tag:string;limit:number;cursor:string|null}[]=[];let at=0;
  return {calls,provider:{tag:async()=>capture({id:'1',slug:opts.tagSlug,label:'Fixture tag'}),
    eventsPage:async(tag:string,limit:number,cursor:string|null)=>{calls.push({tag,limit,cursor});return capture(pages[at++]!);}}};
}
test('keyset pages preserve outcome labels/token order and never select or enable a candidate',async()=>{
  for(const category of ['sports','politics','crypto'] as Category[]){
    const opts={...options,category,tagSlug:category};
    const f=fixture([{events:[event('10')],next_cursor:'opaque_1'},{events:[event('11')],next_cursor:null}],opts);
    const report=await discoverMarkets(f.provider,opts);
    assert.deepEqual(f.calls,[{tag:'1',limit:2,cursor:null},{tag:'1',limit:2,cursor:'opaque_1'}]);
    assert.equal(report.scanComplete,true);assert.equal(report.candidates.length,2);assert.equal(report.configurationsActivated,0);
    assert.equal(report.transactionsSent,0);assert.equal(report.signaturesProduced,0);
    const c=report.candidates[0]!;assert.equal(c.status,'REVIEW_REQUIRED');assert.equal(c.enabled,false);
    assert.equal(c.selectedOutcome,null);assert.equal(c.mappingApproved,false);assert.equal(c.category,category);
    assert.deepEqual(c.outcomes,[{label:'Team A',tokenId:'20'},{label:'Team B',tokenId:'21'}]);
    assert.equal(c.sourceEndDate,'2027-01-01T00:00:00Z');assert.ok(!('scheduledT' in c));
    assert.equal(c.sourcePageSha256,createHash('sha256').update(report.pages[0]!.capture.body).digest('hex'));
  }
});
test('finite scans report truncation without claiming complete pagination or fetching extra pages',async()=>{
  const f=fixture([{events:[event('10')],next_cursor:'opaque'}]);
  const report=await discoverMarkets(f.provider,{...options,maxPages:1});
  assert.equal(report.scanComplete,false);assert.equal(report.stopReason,'MAX_PAGES');assert.equal(report.nextCursor,'opaque');assert.equal(f.calls.length,1);
  for(const next_cursor of [undefined,null,'']){
    const f=fixture([{events:[],next_cursor}]);assert.equal((await discoverMarkets(f.provider,options)).scanComplete,true);
  }
});
test('pagination rejects loops, duplicate identities, malformed pages and non-string IDs',async()=>{
  const variants=[
    {pages:[{events:[event('10')],next_cursor:'a'},{events:[event('11')],next_cursor:'a'}],code:/PAGINATION_STALLED/},
    {pages:[{events:[],next_cursor:'a'}],code:/PAGINATION_STALLED/},
    {pages:[{events:[event('10'),event('10')]}],code:/DUPLICATE_EVENT/},
    {pages:[{events:[event('10'),event('11',market('10'))]}],code:/DUPLICATE_MARKET/},
    {pages:[{events:[event('10'),event('11',{...market('11'),conditionId:market('10').conditionId})]}],code:/DUPLICATE_CONDITION/},
    {pages:[{events:[event('10'),event('11',{...market('11'),clobTokenIds:market('10').clobTokenIds})]}],code:/DUPLICATE_TOKEN/},
    {pages:[{events:[{...event('10'),id:10}]}],code:/BAD_INTEGER_STRING/},
    {pages:[{events:null}],code:/BAD_DISCOVERY_PAGE/},
    {pages:[{events:[event('10'),event('11'),event('12')]}],code:/BAD_DISCOVERY_PAGE/},
    {pages:[{events:[],next_cursor:123}],code:/BAD_DISCOVERY_CURSOR/},
    {pages:[{events:[{...event('10'),markets:null}]}],code:/BAD_DISCOVERY_EVENT/},
  ];
  for(const {pages,code} of variants)await assert.rejects(discoverMarkets(fixture(pages).provider,options),code);
});
test('unknown/null, non-binary, negative-risk and closed metadata remain blocked candidates',async()=>{
  const changes:[Record<string,unknown>,Record<string,unknown>,string][]=[
    [{},{active:null},'MARKET_INACTIVE_UNKNOWN'],[{},{closed:true},'MARKET_CLOSED'],
    [{},{negRisk:true},'NEGATIVE_RISK_REQUIRES_REVIEW'],[{negRiskAugmented:true},{},'AUGMENTED_NEGATIVE_RISK_REQUIRES_REVIEW'],
    [{},{negRiskOther:null},'NEGATIVE_RISK_OTHER_REQUIRES_REVIEW_UNKNOWN'],
    [{},{conditionId:null},'CONDITION_ID_MISSING_OR_INVALID'],[{},{resolutionSource:null},'SOURCE_RULES_INCOMPLETE'],
    [{},{endDate:'2027-01-01'},'SOURCE_END_DATE_UNVERIFIED'],[{},{endDate:'2027-02-30T00:00:00Z'},'SOURCE_END_DATE_UNVERIFIED'],
    [{},{outcomes:'["A","B","C"]'},'OUTCOME_MAPPING_MISSING_OR_INVALID'],
    [{},{clobTokenIds:'["20","20"]'},'OUTCOME_MAPPING_MISSING_OR_INVALID'],[{tags:null},{},'TAG_MEMBERSHIP_UNVERIFIED'],
    [{},{acceptingOrders:'true'},'ORDERS_DISABLED_UNKNOWN'],[{tags:[null]},{},'TAG_MEMBERSHIP_UNVERIFIED']
  ];
  for(const [e,m,reason] of changes){
    const f=fixture([{events:[{...event('10',{...market('10'),...m}),...e}],next_cursor:null}]);
    const report=await discoverMarkets(f.provider,options);const c=report.candidates[0]!;
    assert.equal(c.status,'BLOCKED');assert.ok(c.reasons.includes(reason),JSON.stringify(c.reasons));assert.equal(c.enabled,false);
  }
});
test('discovery rejects schema/body inconsistencies and invalid limits before provider calls',async()=>{
  const f=fixture([{events:[]}]);let tags=0;
  const provider={...f.provider,tag:async()=>{tags++;return capture({id:'1',slug:'other'});}};
  for(const opts of [{...options,maxPages:0},{...options,maxPages:21},{...options,pageSize:101},{...options,pageSize:NaN},
    {...options,tagSlug:'../sports'},{...options,category:'other' as Category}])await assert.rejects(discoverMarkets(provider,opts),/BAD_DISCOVERY_OPTIONS/);
  assert.equal(tags,0);await assert.rejects(discoverMarkets(provider,options),/TAG_IDENTITY_MISMATCH/);
  await assert.rejects(discoverMarkets({...f.provider,tag:async()=>({...capture({id:'1',slug:'sports'}),data:{id:'2',slug:'sports'}})},options),/BODY_DATA_MISMATCH/);
});
test('provider cursor is encoded as data and cannot change allowed host/filter bounds',async()=>{
  const urls:string[]=[];const p=new PublicPolymarket({...config.poll,maxRetries:0},new RequestLimiter(0,10),async url=>{
    urls.push(url);return new Response('{"events":[],"next_cursor":null}');});
  await p.eventsPage('1',2,'cursor&tag_id=99/opaque');const url=new URL(urls[0]!);
  assert.equal(url.hostname,'gamma-api.polymarket.com');assert.equal(url.pathname,'/events/keyset');
  assert.equal(url.searchParams.get('tag_id'),'1');assert.equal(url.searchParams.get('after_cursor'),'cursor&tag_id=99/opaque');
  for(const call of [()=>p.tag('../sports'),()=>p.eventsPage('1',101),()=>p.eventsPage('1',1,'bad cursor')])
    assert.throws(call);assert.equal(urls.length,1);
});
test('metadata identity keeps its existing digest while rejecting duplicate membership and bad known-field types',()=>{
  const m={...market(config.mapping.externalMarketId),conditionId:config.mapping.conditionId,
    outcomes:['Yes','No'],clobTokenIds:[config.mapping.outcomeTokenId,'2']};
  assert.deepEqual(outcomeMapping({...m,outcomes:JSON.stringify(m.outcomes)}),outcomeMapping(m));
  const expected=createHash('sha256').update(JSON.stringify({question:m.question,description:m.description,resolutionSource:m.resolutionSource,
    conditionId:m.conditionId,outcomes:m.outcomes,tokens:m.clobTokenIds,eventId:config.mapping.eventId,endDate:m.endDate,negRisk:m.negRisk,negRiskMarketID:null})).digest('hex');
  assert.equal(metadataIdentity(config,m).rulesDigest,expected);
  for(const change of [{id:Number(m.id)},{resolutionSource:{}},{endDate:123},{negRisk:'false'},{active:'true'}])assert.throws(()=>metadataIdentity(config,{...m,...change}));
  for(const change of [{active:null},{closed:null},{acceptingOrders:null}])assert.equal(metadataIdentity(config,{...m,...change}).tradeable,false);
  const e={id:config.mapping.eventId,markets:[{id:config.mapping.externalMarketId}],active:true,closed:false};
  assert.throws(()=>verifyEventMembership(config,{...e,markets:[...e.markets,...e.markets]}),/EVENT_IDENTITY/);
  assert.throws(()=>verifyEventMembership(config,{...e,markets:[{...e.markets[0],conditionId:'0x'+'f'.repeat(64)}]}),/EVENT_IDENTITY/);
  assert.throws(()=>verifyEventMembership(config,{...e,resolutionSource:{}}),/BAD_SOURCE_METADATA_SCHEMA/);
  assert.equal(verifyEventMembership(config,{...e,active:null}).tradeable,false);
});
