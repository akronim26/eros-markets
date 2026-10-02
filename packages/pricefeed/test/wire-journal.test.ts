import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAddress, hashMessage } from 'viem';
import { observationDigest, parseObservation, type Observation, submitCalldata } from '../src/wire.js';
import { Journal } from '../src/journal.js';

export const fixtureObservation:Observation={marketId:'0x'+'01'.repeat(32),sourceId:'0x'+'02'.repeat(32),sequence:1n,observedAt:9990n,publishedAt:9995n,priceWad:600000000000000000n,impactBidWad:590000000000000000n,impactAskWad:610000000000000000n,bidDepthLots:5000n,askDepthLots:5000n,sourceRulesHash:'0x'+'03'.repeat(32)};
const engine='0x1111111111111111111111111111111111111111';
test('wire digest binds every field and chain/engine domain; raw recovery differs from personal signing', async()=>{
  const digest=observationDigest(fixtureObservation,31337n,engine);
  const account=privateKeyToAccount('0x'+'11'.repeat(32)); // Explicit deterministic test key only.
  const signature=await account.sign({hash:digest});
  assert.equal(signature.length,132);
  assert.equal((await recoverAddress({hash:digest,signature})).toLowerCase(),account.address.toLowerCase());
  assert.notEqual(await recoverAddress({hash:hashMessage({raw:digest}),signature}),account.address);
  for(const field of Object.keys(fixtureObservation) as (keyof Observation)[]){
    const value=fixtureObservation[field];
    const changed={...fixtureObservation,[field]:typeof value==='bigint'?value+1n:'0x'+'ff'.repeat(32)};
    assert.notEqual(observationDigest(changed,31337n,engine),digest,field);
  }
  assert.notEqual(observationDigest(fixtureObservation,31338n,engine),digest);
  assert.notEqual(observationDigest(fixtureObservation,31337n,'0x2222222222222222222222222222222222222222'),digest);
  assert.ok(submitCalldata(fixtureObservation,signature).startsWith('0x'));
});
test('wire parsing rejects missing/extra fields, unsafe numbers, reversed times and overflow',()=>{
  const raw=JSON.parse(JSON.stringify(fixtureObservation,(_k,v)=>typeof v==='bigint'?v.toString():v));
  assert.deepEqual(parseObservation(raw),fixtureObservation);
  assert.throws(()=>parseObservation({...raw,acceptedAt:'10000'}));
  assert.throws(()=>parseObservation({...raw,sequence:1}));
  assert.throws(()=>parseObservation({...raw,sequence:(1n<<64n).toString()}));
  assert.throws(()=>parseObservation({...raw,publishedAt:'9989'}));
});
test('SQLite raw evidence survives restart; duplicate writers are fenced and expired owners cannot append',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pricefeed-journal-'));
  const path=join(directory,'journal.sqlite');
  let a:Journal|undefined,b:Journal|undefined;
  try{
    a=new Journal(path);b=new Journal(path);
    const fence=a.acquire('crypto','writer-a',1000n,1000n);
    assert.throws(()=>b!.acquire('crypto','writer-b',1001n,1000n),/WRITER_BUSY/);
    a.append('crypto','writer-a',fence,1002n,{body:'{"timestamp":"999"}',status:'DEGRADED'});
    a.close();a=undefined;
    const takeover=b.acquire('crypto','writer-b',2000n,1000n);
    assert.ok(takeover>fence);
    assert.throws(()=>b!.append('crypto','writer-a',fence,2001n,{body:'unsafe'}),/WRITER_FENCED/);
    const rows=b.read('crypto');assert.equal(rows.length,1);assert.equal(rows[0]!.payload.body,'{"timestamp":"999"}');
    assert.equal(b.verify(),true);
  }finally{a?.close();b?.close();rmSync(directory,{recursive:true,force:true});}
});
