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
