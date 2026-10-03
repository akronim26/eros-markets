import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeRules, parseRules, rulesHash, RULES_FIELDS, type RulesManifest } from '../src/rules.js';
import { PacketStore } from '../src/packet-store.js';
import { prepareObservation, signPrepared, DEVELOPMENT_POLICIES, type RawSigner } from '../src/publication.js';
import { parseConfig, type MarketConfig } from '../src/config.js';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { createHash } from 'node:crypto';
import { observationDigest } from '../src/wire.js';

const h=(byte:string)=>'0x'+byte.repeat(32);
const key=('0x'+'11'.repeat(32)) as Hex; // Public deterministic fixture only.
const account=privateKeyToAccount(key);
const base=parseConfig(JSON.parse(readFileSync(new URL('../../config/crypto.example.json',import.meta.url),'utf8')));
const manifest:RulesManifest={schemaVersion:'1',venue:'polymarket',marketId:h('01'),sourceId:h('02'),
  eventId:base.mapping.eventId,externalMarketId:base.mapping.externalMarketId,conditionId:base.mapping.conditionId,
  outcomeTokenId:base.mapping.outcomeTokenId,outcomeLabel:'Yes',erosRulesHash:h('03'),externalRulesDigest:h('04'),
  quotePolicyHash:h('05'),quantityPolicyHash:h('06'),timestampPolicyHash:h('07'),failurePolicyHash:h('08'),
  scheduledT:'100000',depthNLots:'5000',maxSpreadWad:'50000000000000000',pricingPolicy:'before-fee-vwap-bid-floor-ask-ceil-mid-floor-depth-total-floor-v1'};
const cfg:MarketConfig={...base,pricing:{depthNLots:'5000',maxSpreadWad:manifest.maxSpreadWad,impactMethod:'vwap'},
  destination:{chainId:'31337',engineAddress:'0x1111111111111111111111111111111111111111',engineCodeHash:h('aa'),abiHash:h('bb'),
    marketId:manifest.marketId,sourceId:manifest.sourceId,sourceRulesHash:rulesHash(manifest),signerAddress:account.address,
    listedAt:'0',scheduledT:manifest.scheduledT,invalidRule:{fallbackListed:true,captureGraceSecs:'3600',voidSecs:'2592000',fallbackPriceWad:'500000000000000000'}}};
const metadata={id:base.mapping.externalMarketId,conditionId:base.mapping.conditionId,outcomes:['Yes','No'],
  clobTokenIds:[base.mapping.outcomeTokenId,'2'],question:'Fixture question',description:'Fixture rules',active:true,closed:false,enableOrderBook:true,acceptingOrders:true};
const event={id:base.mapping.eventId,markets:[{id:base.mapping.externalMarketId}],active:true,closed:false};
const body=JSON.stringify({market:base.mapping.conditionId,asset_id:base.mapping.outcomeTokenId,timestamp:'1000000',hash:'vendor',
  tick_size:'0.01',min_order_size:'5',bids:[{price:'0.59',size:'6'}],asks:[{price:'0.61',size:'6'}]});
const marketIdentity=metadataIdentity(cfg,metadata),eventIdentity=verifyEventMembership(cfg,event);
const rulesDigest=createHash('sha256').update(`${eventIdentity.rulesDigest}:${marketIdentity.rulesDigest}`).digest('hex');
const reviewed={...manifest,...DEVELOPMENT_POLICIES,externalRulesDigest:'0x'+rulesDigest};
const config={...cfg,destination:{...cfg.destination!,sourceRulesHash:rulesHash(reviewed)}};
const candidate=(sequence:bigint,now=1000100n)=>prepareObservation(config,reviewed,{bookBody:body,metadata,event,
  bookReceivedAtMs:1000050n,metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},sequence,now,1000n);
const signer:RawSigner={address:account.address,signDigest:async(request)=>account.sign({hash:request.digest})};

test('candidate rules encoding agrees with independently assembled ABI words and is presentation independent',()=>{
  const word=(n:bigint)=>n.toString(16).padStart(64,'0');
  const words=RULES_FIELDS.map(([name,type])=>{
    const value=manifest[name];
    return type==='bytes32'?(String(value).startsWith('0x')?String(value).slice(2):keccak256(stringToHex(value)).slice(2)):word(BigInt(value));
  });
  // Domains and text hashes are fixed-size bytes32; all fields are static ABI words.
  const encoded=encodeRules(manifest);
  assert.equal(encoded,'0x'+words.join(''));
  assert.equal(rulesHash(manifest),keccak256(('0x'+words.join('')) as Hex));
  const reordered=Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(rulesHash(parseRules(reordered)),rulesHash(manifest));
  for(const field of ['outcomeTokenId','depthNLots','scheduledT'] as const)
    assert.notEqual(rulesHash({...manifest,[field]:(BigInt(manifest[field])+1n).toString()}),rulesHash(manifest));
  assert.throws(()=>parseRules({...manifest,extra:'hidden'}));
  assert.throws(()=>parseRules({...manifest,depthNLots:'0'}));
});
test('builder recomputes raw book and metadata, binds rules, preserves source time and checks headroom',()=>{
  const packet=candidate(1n);
  assert.equal(packet.observation.observedAt,1000n);
  assert.equal(packet.observation.publishedAt,1000n);
  assert.equal(packet.observation.priceWad,600000000000000000n);
  assert.equal(packet.observation.bidDepthLots,6000n);
  assert.throws(()=>candidate(1n,1029001n),/HEADROOM/);
  assert.throws(()=>candidate(1n,999999n),/TIME/);
  assert.throws(()=>prepareObservation(config,{...reviewed,outcomeLabel:'No'},
    {bookBody:body,metadata,event,bookReceivedAtMs:1000050n,metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},1n,1000100n,1000n),/RULES/);
  assert.throws(()=>prepareObservation(config,reviewed,{bookBody:body,metadata:{...metadata,description:'changed'},event,
    bookReceivedAtMs:1000050n,metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},1n,1000100n,1000n),/RULES/);
});
test('durable allocation burns expired sequences, survives restart, separates domains and fences stale owners',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-packets-')),path=join(dir,'packets.sqlite');
  let a:PacketStore|undefined,b:PacketStore|undefined;
  try{
    a=new PacketStore(path);b=new PacketStore(path);
    const domain=candidate(1n).domain,f=a.acquire(domain,'a',1000100n,1000n);
    a.reconcile(domain,'a',f,1000100n,{lastSequence:0n,lastObservedAt:0n});
    const first=a.allocate(domain,'a',f,1000100n,s=>candidate(s));
    assert.equal(first.observation.sequence,1n);
    a.expire(domain,'a',f,1000101n,1n,'insufficient headroom');
    assert.throws(()=>b!.acquire(domain,'b',1000102n,1000n),/BUSY/);
    a.close();a=undefined;
    const g=b.acquire(domain,'b',1001100n,1000n);
    assert.throws(()=>b!.allocate(domain,'b',g,1001100n,s=>candidate(s,1001100n)),/RECONCILE/);
    b.reconcile(domain,'b',g,1001100n,{lastSequence:0n,lastObservedAt:0n});
    assert.equal(b.allocate(domain,'b',g,1001100n,s=>candidate(s,1001100n)).observation.sequence,2n);
    assert.throws(()=>b!.expire(domain,'a',f,1001101n,2n,'old owner'),/FENCED/);
    assert.throws(()=>b!.reconcile(domain,'b',g,1001101n,{lastSequence:8n,lastObservedAt:1000n}),/UNKNOWN_CHAIN/);
    assert.throws(()=>b!.allocate(domain,'b',g,1001101n,s=>candidate(s)),/RECONCILE/);
    assert.equal(b.verify(),true);
  }finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});
test('signing persists exact raw signature and retries return the frozen packet without signing again',async()=>{
  const store=new PacketStore(':memory:');let now=1000100n,calls=0;
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'owner',now,100000n);
    store.reconcile(domain,'owner',f,now,{lastSequence:0n,lastObservedAt:0n});
    const p=store.allocate(domain,'owner',f,now,s=>candidate(s));
    const backend={...signer,signDigest:async(request:Parameters<RawSigner['signDigest']>[0])=>{calls++;return signer.signDigest(request);}};
    const signed=await signPrepared(store,domain,'owner',f,1n,backend,()=>now,1000n);
    now+=500n;
    const retry=await signPrepared(store,domain,'owner',f,1n,backend,()=>now,1000n);
    assert.deepEqual(retry,signed);assert.equal(calls,1);
    assert.equal(signed.packet.observation.publishedAt,p.observation.publishedAt);
    assert.equal(signed.digest,observationDigest(p.observation,31337n,config.destination!.engineAddress));
  }finally{store.close();}
});
test('signing delay expires frozen packet and retains signature evidence; signer/domain mismatch fails',async()=>{
  const store=new PacketStore(':memory:');let now=1000100n;
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'owner',now,100000n);
    store.reconcile(domain,'owner',f,now,{lastSequence:0n,lastObservedAt:0n});
    store.allocate(domain,'owner',f,now,s=>candidate(s));
    assert.equal((await signPrepared(store,domain,'owner',f,1n,{...signer,signDigest:async(r)=>{const sig=await signer.signDigest(r);now=1030001n;return sig;}},()=>now,1000n)).state,'EXPIRED');
    assert.ok(store.get(domain,1n)!.signature);
    assert.equal(store.get(domain,1n)!.packet.observation.publishedAt,1000n);
    assert.throws(()=>store.reconcile(domain,'owner',f,now,{lastSequence:1n,lastObservedAt:999n}),/CHAIN_TIME/);
  }finally{store.close();}
});
