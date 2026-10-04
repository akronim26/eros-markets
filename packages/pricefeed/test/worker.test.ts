import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/journal.js';
import { parseConfig } from '../src/config.js';
import { Worker, ensureUniqueWorkers } from '../src/worker.js';
import type { Capture } from '../src/polymarket.js';
import { healthView } from '../src/health.js';

const cfg=parseConfig(JSON.parse(readFileSync(new URL('../../config/crypto.example.json',import.meta.url),'utf8')));
const metadata={id:cfg.mapping.externalMarketId,events:[{id:cfg.mapping.eventId}],conditionId:cfg.mapping.conditionId,outcomes:'["Yes","No"]',clobTokenIds:JSON.stringify([cfg.mapping.outcomeTokenId,'2']),question:'BTC threshold',description:'Exact test rules',active:true,closed:false,enableOrderBook:true,acceptingOrders:true};
const book={market:cfg.mapping.conditionId,asset_id:cfg.mapping.outcomeTokenId,timestamp:'1000000',hash:'vendor',tick_size:'0.01',min_order_size:'5',bids:[{price:'0.6',size:'1000'}],asks:[{price:'0.61',size:'1000'}]};
const capture=(data:Record<string,unknown>,at:bigint):Capture=>({url:'https://clob.polymarket.com/book',receivedAtMs:at,latencyMs:1n,body:JSON.stringify(data),headers:{},data,attempts:1});
const event={id:cfg.mapping.eventId,markets:[{id:cfg.mapping.externalMarketId}],active:true,closed:false};
test('worker recovery preserves source ordering; rule quarantine stays latched',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-worker-'));const j=new Journal(join(dir,'archive.sqlite'));
  let now=1000100n,currentBook=book,currentMetadata=metadata;
  const provider={event:async()=>capture(event,now),metadata:async()=>capture(currentMetadata,now),book:async()=>capture(currentBook,now)};
  try{
    const a=new Worker(cfg,provider,j,'same-owner',()=>now);
    assert.equal((await a.poll()).inspection.status,'COLLECTING');
    currentBook={...book,timestamp:'999000'};
    const restored=new Worker(cfg,provider,j,'same-owner',()=>now);
    assert.equal((await restored.poll()).inspection.status,'QUARANTINED');
    currentBook=book;
    assert.equal((await restored.poll()).inspection.status,'QUARANTINED');
    assert.equal(j.read(restored.namespace).length,3);
    currentMetadata={...metadata,description:'changed'};
  }finally{j.close();rmSync(dir,{recursive:true,force:true});}
});
test('one source outage becomes evidence while another worker can continue',async()=>{
  const j=new Journal(':memory:');let now=1000100n;
  const bad={event:async()=>capture(event,now),metadata:async()=>{throw new Error('provider outage');},book:async()=>capture(book,now)};
  try{
    const failed=new Worker({...cfg,key:'bad'},bad,j,'owner',()=>now);
    const healthy=new Worker({...cfg,key:'good',mapping:{...cfg.mapping,outcomeTokenId:'3'}},{event:async()=>capture(event,now),metadata:async()=>capture({...metadata,clobTokenIds:'["3","2"]'},now),book:async()=>capture({...book,asset_id:'3'},now)},j,'owner',()=>now);
    const rows=await Promise.all([failed.poll(),healthy.poll()]);
    assert.equal(rows[0]!.inspection.status,'DEGRADED');assert.equal(rows[1]!.inspection.status,'COLLECTING');
    assert.equal(j.verify(),true);
    assert.throws(()=>ensureUniqueWorkers([cfg,{...cfg,key:'alias'}]),/DUPLICATE/);
  }finally{j.close();}
});
test('health query never labels an old captured sample as currently collecting',()=>{
  const payload={worker:'crypto',inspection:{status:'COLLECTING',reason:null,time:{observedAt:'1000',sourceMs:'1000000'}}};
  assert.equal(healthView(payload,1029000n).currentStatus,'COLLECTING');
  assert.equal(healthView(payload,1031000n).currentStatus,'DEGRADED');
  assert.equal(healthView(payload,1031000n).freshAtQuery,false);
  assert.equal(healthView({...payload,inspection:{...payload.inspection,time:{observedAt:'1000',sourceMs:'1000500'}}},1000499n).freshAtQuery,false);
});
test('event metadata age is checked even when the market response is newer',async()=>{
  const j=new Journal(':memory:');const now=1000100n;
  const worker=new Worker(cfg,{event:async()=>capture(event,900000n),metadata:async()=>capture(metadata,now),book:async()=>capture(book,now)},j,'owner',()=>now);
  try{
    const result=await worker.poll();assert.equal(result.inspection.status,'DEGRADED');
    assert.equal(result.inspection.reason,'STALE_METADATA');
  }finally{j.close();}
});
test('wrong-event metadata is quarantined and its raw response remains archived',async()=>{
  const j=new Journal(':memory:');const now=1000100n;
  const rejected={...event,id:'1'};
  const worker=new Worker(cfg,{event:async()=>capture(rejected,now),metadata:async()=>capture(metadata,now),book:async()=>capture(book,now)},j,'owner',()=>now);
  try{
    const result=await worker.poll();assert.equal(result.inspection.status,'QUARANTINED');
    assert.deepEqual(JSON.parse(String((j.latest(worker.namespace)!.payload.event as Record<string,unknown>).body)),rejected);
    assert.equal(result.book,null);
  }finally{j.close();}
});
test('source status changes are archived, latched across restart and never silently reopen',async()=>{
  for(const change of [{closed:true},{acceptingOrders:false},{active:null},{negRiskOther:true}]){
    const j=new Journal(':memory:');let now=1000100n,currentMetadata={...metadata,negRiskOther:false} as Record<string,unknown>;
    const provider={event:async()=>capture(event,now),metadata:async()=>capture(currentMetadata,now),book:async()=>capture({...book,timestamp:String(now)},now)};
    try{
      const worker=new Worker(cfg,provider,j,'owner',()=>now);const first=await worker.poll();assert.equal(first.inspection.status,'COLLECTING');
      now+=BigInt(cfg.poll.metadataMaxAgeMs);currentMetadata={...currentMetadata,...change};
      const rejected=await worker.poll();assert.equal(rejected.inspection.status,'QUARANTINED');
      assert.equal(rejected.inspection.reason,'SOURCE_STATUS_CHANGED_REVIEW_REQUIRED');assert.equal(rejected.book,null);
      assert.deepEqual(JSON.parse(rejected.metadata!.body),currentMetadata);assert.equal(rejected.baselineStatusDigest,first.baselineStatusDigest);
      currentMetadata={...metadata,negRiskOther:false};const restored=new Worker(cfg,provider,j,'owner',()=>now);
      assert.equal((await restored.poll()).inspection.status,'QUARANTINED');assert.equal(j.verify(),true);
    }finally{j.close();}
  }
});
test('status monitoring derives an old-format baseline from retained bytes without rewriting history',async()=>{
  const j=new Journal(':memory:');let now=1000100n,currentMetadata:Record<string,unknown>={...metadata};
  const provider={event:async()=>capture(event,now),metadata:async()=>capture(currentMetadata,now),book:async()=>capture({...book,timestamp:String(now)},now)};
  try{
    const first=new Worker(cfg,provider,j,'owner',()=>now);const result=await first.poll();first.releaseLease();
    const {baselineStatusDigest:_removed,...legacy}=result;
    const fence=j.acquire(first.namespace,'owner',now,10000n);j.append(first.namespace,'owner',fence,now,legacy);j.release(first.namespace,'owner',fence);
    const before=j.read(first.namespace);currentMetadata={...metadata,closed:true};now+=1000n;
    const upgraded=new Worker(cfg,provider,j,'owner',()=>now),changed=await upgraded.poll();
    assert.equal(changed.inspection.reason,'SOURCE_STATUS_CHANGED_REVIEW_REQUIRED');assert.equal(changed.inspection.status,'QUARANTINED');
    assert.deepEqual(j.read(first.namespace).slice(0,before.length),before);
  }finally{j.close();}
});
test('failed metadata refresh cannot reuse old healthy metadata on a later poll',async()=>{
  const j=new Journal(':memory:');let now=1000100n,currentMetadata:Record<string,unknown>=metadata,metadataCalls=0,bookCalls=0;
  const provider={event:async()=>capture(event,now),metadata:async()=>{metadataCalls++;return capture(currentMetadata,now);},
    book:async()=>{bookCalls++;return capture({...book,timestamp:String(now)},now);}};
  try{
    const worker=new Worker(cfg,provider,j,'owner',()=>now);assert.equal((await worker.poll()).inspection.status,'COLLECTING');
    now+=BigInt(cfg.poll.metadataMaxAgeMs);currentMetadata={...metadata,active:'true'};
    for(let i=0;i<2;i++){const bad=await worker.poll();assert.equal(bad.inspection.status,'DEGRADED');assert.equal(bad.book,null);}
    assert.equal(metadataCalls,3);assert.equal(bookCalls,1);
    currentMetadata=metadata;assert.equal((await worker.poll()).inspection.status,'COLLECTING');assert.equal(metadataCalls,4);
  }finally{j.close();}
});
test('changed rules quarantine before fetching another book and cannot change configured deadlines',async()=>{
  const j=new Journal(':memory:');let now=1000100n,currentMetadata=metadata,books=0;
  const provider={event:async()=>capture(event,now),metadata:async()=>capture(currentMetadata,now),book:async()=>{books++;return capture(book,now);}};
  try{
    const worker=new Worker(cfg,provider,j,'owner',()=>now);await worker.poll();const deadline=cfg.destination?.scheduledT;
    now+=BigInt(cfg.poll.metadataMaxAgeMs);currentMetadata={...metadata,description:'Changed exception rules'};
    const changed=await worker.poll();assert.equal(changed.inspection.status,'QUARANTINED');assert.equal(changed.inspection.reason,'SOURCE_RULES_CHANGED');
    assert.equal(books,1);assert.equal(cfg.destination?.scheduledT,deadline);assert.equal(changed.book,null);
    assert.equal(JSON.parse(changed.metadata!.body).description,currentMetadata.description);
    const restored=new Worker(cfg,provider,j,'owner',()=>now);assert.equal((await restored.poll()).inspection.status,'QUARANTINED');
  }finally{j.close();}
});
