import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, stringToHex, type Hex } from 'viem';
import { encodeRules, parseRules, rulesHash, RULES_FIELDS } from '../src/rules.js';
import { PacketStore } from '../src/packet-store.js';
import { prepareObservation, signPrepared, type RawSigner } from '../src/publication.js';
import { createHash } from 'node:crypto';
import { observationDigest } from '../src/wire.js';
import { DatabaseSync } from 'node:sqlite';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { copyFileSync } from 'node:fs';

import { h, account, manifest, reviewed, config, metadata, event, body, candidate, signer } from './publication-fixture.js';

test('candidate rules encoding agrees with independently assembled ABI words and is presentation independent',()=>{
  const word=(n:bigint)=>n.toString(16).padStart(64,'0');
  const words=RULES_FIELDS.map(([name,type])=>{
    const value=manifest[name];
    return type==='bytes32'?(String(value).startsWith('0x')?String(value).slice(2):keccak256(stringToHex(value)).slice(2)):word(BigInt(value));
  });
  // Domains and text hashes are fixed-size bytes32; all fields are static ABI words.
  const encoded=encodeRules(manifest);
  const domainWord=keccak256(stringToHex('EROS_POLYMARKET_INDEX_RULES_V1')).slice(2);
  assert.equal(encoded,'0x'+domainWord+words.join(''));
  assert.equal(rulesHash(manifest),keccak256(('0x'+domainWord+words.join('')) as Hex));
  const reordered=Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(rulesHash(parseRules(reordered)),rulesHash(manifest));
  for(const field of ['outcomeTokenId','depthNLots','scheduledT'] as const)
    assert.notEqual(rulesHash({...manifest,[field]:(BigInt(manifest[field])+1n).toString()}),rulesHash(manifest));
  assert.throws(()=>parseRules({...manifest,extra:'hidden'}));
  assert.throws(()=>parseRules({...manifest,depthNLots:'0'}));
});
test('independent signer journal makes retries idempotent and detects a restored packet archive behind signing',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-signer-')),path=join(dir,'packets.sqlite'),backup=join(dir,'old.sqlite'),signerPath=join(dir,'signer.sqlite');
  const domain=candidate(1n).domain;let now=1000100n,store=new PacketStore(path),backend:LocalTestSigner|undefined;
  try{
    store.acquire(domain,'owner',now,100n);store.close();copyFileSync(path,backup);store=new PacketStore(path);
    const f=store.acquire(domain,'owner',now,100n);backend=new LocalTestSigner(signerPath,domain,store,()=>now);
    backend.reconcile('owner',f,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,'owner',f,now,s=>candidate(s));
    const unsigned=store.beginSign(domain,'owner',f,now,1n),request={identity:`31337:${domain.engine}:${domain.sourceId}:1`,digest:unsigned.digest,owner:'owner',fence:f};
    const signature=await backend.signDigest(request);
    assert.equal(await backend.signDigest(request),signature);
    await assert.rejects(backend.signDigest({...request,digest:h('ff') as Hex}),/PACKET_MISMATCH/);
    assert.equal((await signPrepared(store,domain,'owner',f,1n,backend,()=>now,1000n)).signature,signature);
    backend.close();backend=undefined;store.close();now+=100n;
    store=new PacketStore(backup);const g=store.acquire(domain,'restored',now,10000n);
    backend=new LocalTestSigner(signerPath,domain,store,()=>now);
    assert.throws(()=>backend!.reconcile('restored',g,{lastSequence:0n,lastObservedAt:0n}),/SIGNER_JOURNAL_AHEAD/);
    assert.throws(()=>store.allocate(domain,'restored',g,now,s=>candidate(s,now)),/RECONCILE/);
  }finally{backend?.close();store.close();rmSync(dir,{recursive:true,force:true});}
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
test('durable allocation burns expired sequences, survives restart and fences stale owners',()=>{
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
test('signing delay expires frozen packet and retains signature evidence',async()=>{
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
test('signing crash retry uses identical identity/digest; overlapping calls are blocked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-sign-crash-')),path=join(dir,'packets.sqlite');
  let store=new PacketStore(path),now=1000100n;
  const requests:{identity:string;digest:Hex}[]=[];
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'first',now,100n);
    store.reconcile(domain,'first',f,now,{lastSequence:0n,lastObservedAt:0n});
    store.allocate(domain,'first',f,now,s=>candidate(s));
    await assert.rejects(signPrepared(store,domain,'first',f,1n,{...signer,signDigest:async(r)=>{requests.push(r);throw new Error('simulated backend timeout after signing');}},()=>now,1000n));
    assert.equal(store.get(domain,1n)!.state,'SIGNING');
    store.close();store=new PacketStore(path);now+=100n;
    const g=store.acquire(domain,'restored',now,10000n);
    store.reconcile(domain,'restored',g,now,{lastSequence:0n,lastObservedAt:0n});
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    const pending=signPrepared(store,domain,'restored',g,1n,{...signer,signDigest:async(r)=>{requests.push(r);await gate;return signer.signDigest(r);}},()=>now,1000n);
    await assert.rejects(signPrepared(store,domain,'restored',g,1n,signer,()=>now,1000n),/BUSY/);
    release();assert.equal((await pending).state,'SIGNED');
    assert.equal(requests[0]!.identity,requests[1]!.identity);assert.equal(requests[0]!.digest,requests[1]!.digest);
    store.reconcile(domain,'restored',g,now,{lastSequence:1n,lastObservedAt:1000n});
    assert.equal(store.allocate(domain,'restored',g,now,s=>candidate(s,now)).observation.sequence,2n);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('independent domains start independent sequences; mutation of returned objects cannot alter journal',()=>{
  const store=new PacketStore(':memory:');
  try{
    const first=candidate(1n),other={...first.domain,engine:'0x2222222222222222222222222222222222222222'};
    for(const domain of [first.domain,other]){
      const fence=store.acquire(domain,'owner',1000100n,10000n);store.reconcile(domain,'owner',fence,1000100n,{lastSequence:0n,lastObservedAt:0n});
      const allocated=store.allocate(domain,'owner',fence,1000100n,s=>({...candidate(s),domain}));
      assert.equal(allocated.observation.sequence,1n);allocated.observation.priceWad=1n;
      assert.equal(store.get(domain,1n)!.packet.observation.priceWad,600000000000000000n);
    }
    assert.throws(()=>store.acquire({...first.domain,rulesHash:h('ff')},'owner',1000100n,10000n),/DOMAIN_CHANGED/);
  }finally{store.close();}
});
test('corrupt packet or regressed sequence counter refuses startup',()=>{
  for(const sql of ["UPDATE packets SET body='{}'","UPDATE packet_workers SET next_seq='1'"]){
    const dir=mkdtempSync(join(tmpdir(),'pricefeed-corrupt-')),path=join(dir,'packets.sqlite');
    try{
      const store=new PacketStore(path),domain=candidate(1n).domain,f=store.acquire(domain,'owner',1000100n,10000n);
      store.reconcile(domain,'owner',f,1000100n,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,'owner',f,1000100n,s=>candidate(s));store.close();
      const db=new DatabaseSync(path);db.exec(sql);db.close();
      assert.throws(()=>new PacketStore(path),/INTEGRITY/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});
test('non-raw signature, wrong signer, lost lease and production chain cannot publish',async()=>{
  const store=new PacketStore(':memory:');let now=1000100n;
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'owner',now,1000n);
    store.reconcile(domain,'owner',f,now,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,'owner',f,now,s=>candidate(s));
    await assert.rejects(signPrepared(store,domain,'owner',f,1n,{...signer,address:'0x2222222222222222222222222222222222222222'},()=>now,1000n),/IDENTITY/);
    await assert.rejects(signPrepared(store,{...domain,chainId:1n},'owner',f,1n,signer,()=>now,1000n),/DEVELOPMENT_CHAIN/);
    await assert.rejects(signPrepared(store,domain,'owner',f,1n,{...signer,signDigest:async(r)=>account.signMessage({message:{raw:r.digest}})},()=>now,1000n),/RECOVERY/);
    await assert.rejects(signPrepared(store,domain,'owner',f,1n,{...signer,signDigest:async(r)=>{const sig=await signer.signDigest(r);now+=1000n;store.acquire(domain,'replacement',now,10000n);return sig;}},()=>now,1000n),/FENCED/);
    assert.equal(store.get(domain,1n)!.signature,null);
  }finally{store.close();}
});
test('uint64 exhaustion stops allocation without wrapping or altering prior packet',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-exhaustion-')),path=join(dir,'packets.sqlite');
  let store=new PacketStore(path);
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'owner',1000100n,10000n);
    store.reconcile(domain,'owner',f,1000100n,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,'owner',f,1000100n,s=>candidate(s));store.close();
    const max=(1n<<64n)-1n,p=candidate(max),body=JSON.stringify(p,(_k,v)=>typeof v==='bigint'?v.toString():v,2);
    const db=new DatabaseSync(path);
    db.prepare('UPDATE packets SET sequence=?,body=?,sha256=?,digest=?').run(max.toString(),body,createHash('sha256').update(body).digest('hex'),observationDigest(p.observation,domain.chainId,domain.engine));
    db.prepare('UPDATE packet_workers SET next_seq=?').run((max+1n).toString());db.close();
    store=new PacketStore(path);store.reconcile(domain,'owner',f,1000100n,{lastSequence:0n,lastObservedAt:0n});
    assert.throws(()=>store.allocate(domain,'owner',f,1000100n,s=>candidate(s)),/EXHAUSTED/);
    assert.equal(store.get(domain,max)!.packet.observation.sequence,max);assert.equal(store.verify(),true);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('invalid signature serialization is rejected and old packet schema requires explicit migration',async()=>{
  const store=new PacketStore(':memory:');
  try{
    const domain=candidate(1n).domain,f=store.acquire(domain,'owner',1000100n,10000n);
    store.reconcile(domain,'owner',f,1000100n,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,'owner',f,1000100n,s=>candidate(s));
    for(const signature of [('0x'+'00'.repeat(65)),('0x'+'01'.repeat(32)+'ff'.repeat(32)+'1b')])
      await assert.rejects(signPrepared(store,domain,'owner',f,1n,{...signer,signDigest:async()=>signature as Hex},()=>1000100n,1000n),/NONCANONICAL/);
  }finally{store.close();}
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-old-schema-')),path=join(dir,'old.sqlite');
  try{
    const db=new DatabaseSync(path);db.exec('CREATE TABLE packets(ns TEXT,sequence TEXT,body TEXT,sha256 TEXT,digest TEXT,signature TEXT,state TEXT,reason TEXT)');db.close();
    assert.throws(()=>new PacketStore(path),/SCHEMA_REVIEW_REQUIRED/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
