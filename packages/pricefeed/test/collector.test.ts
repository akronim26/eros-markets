import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { parseConfig } from '../src/config.js';
import { inspectSnapshot, metadataIdentity } from '../src/collector.js';

const cfg=parseConfig(JSON.parse(readFileSync(new URL('../../config/crypto.example.json',import.meta.url),'utf8')));
const raw={market:cfg.mapping.conditionId,asset_id:cfg.mapping.outcomeTokenId,timestamp:'1000000',hash:'vendor-hash',tick_size:'0.01',min_order_size:'5',bids:[{price:'0.6',size:'1000'}],asks:[{price:'0.61',size:'1000'}]};
const metadata={id:cfg.mapping.externalMarketId,conditionId:cfg.mapping.conditionId,outcomes:'["Yes","No"]',clobTokenIds:JSON.stringify([cfg.mapping.outcomeTokenId,'2']),question:'BTC threshold',description:'Exact test rules',resolutionSource:'Test venue',active:true,closed:false,enableOrderBook:true,acceptingOrders:true};
test('collection validates explicit outcome identity and archives raw source time', () => {
  const m=metadataIdentity(cfg,metadata);
  const r=inspectSnapshot(cfg,raw,1000100n,null,m,1000000n);
  assert.equal(r.status,'COLLECTING');
  assert.equal(r.time!.observedAt,1000n);
  assert.equal(r.summary!.priceWad,605000000000000000n);
  assert.equal(r.engineObservation,null);
  assert.throws(() => metadataIdentity(cfg,{...metadata,outcomes:'["No","Yes"]'}));
  assert.equal(inspectSnapshot(cfg,{...raw,asset_id:'2'},1000100n,null,m,1000000n).status,'QUARANTINED');
});
test('stale, thin, closed, changed rules and missing source time remain explicit unavailability', () => {
  const m=metadataIdentity(cfg,metadata);
  assert.equal(inspectSnapshot(cfg,raw,1031000n,null,m,1000000n).status,'DEGRADED');
  assert.equal(inspectSnapshot(cfg,{...raw,bids:[{price:'0.6',size:'1'}]},1000100n,null,m,1000000n).status,'INVALID_DEPTH');
  assert.equal(inspectSnapshot(cfg,{...raw,timestamp:null},1000100n,null,m,1000000n).status,'DEGRADED');
  assert.equal(inspectSnapshot(cfg,raw,1000100n,null,{...m,tradeable:false},1000000n).status,'DEGRADED');
  const changed=metadataIdentity(cfg,{...metadata,description:'Different settlement terms'});
  assert.notEqual(changed.rulesDigest,m.rulesDigest);
  assert.equal(inspectSnapshot(cfg,raw,1000100n,null,changed,1000000n,m.rulesDigest).status,'QUARANTINED');
});
test('adapter bounds responses and rejects redirects and unexpected hosts', async () => {
  const transport=async () => new Response('x'.repeat(1000),{status:200});
  const a=new PublicPolymarket({...cfg.poll,bodyLimitBytes:100,maxRetries:0},new RequestLimiter(0,10),transport);
  await assert.rejects(()=>a.book(cfg.mapping.outcomeTokenId),/RESPONSE_TOO_LARGE/);
  const redirected=new PublicPolymarket({...cfg.poll,maxRetries:0},new RequestLimiter(0,10),async()=>new Response('',{status:302,headers:{location:'https://evil.example'}}));
  await assert.rejects(()=>redirected.book(cfg.mapping.outcomeTokenId),/HTTP_302/);
  await assert.rejects(()=>a.request('https://evil.example/book'),/HOST_NOT_ALLOWED/);
});
test('429 and transport failures retry boundedly; failure is never a fabricated book', async () => {
  let attempts=0;
  const a=new PublicPolymarket({...cfg.poll,retryDelayMs:0,maxRetries:1},new RequestLimiter(0,10),async()=>{attempts++;return new Response('busy',{status:429});});
  await assert.rejects(()=>a.book(cfg.mapping.outcomeTokenId),/HTTP_429/);
  assert.equal(attempts,2);
  const broken=new PublicPolymarket({...cfg.poll,maxRetries:0},new RequestLimiter(0,10),async()=>{throw new Error('connection reset');});
  await assert.rejects(()=>broken.book(cfg.mapping.outcomeTokenId),/connection reset/);
});
