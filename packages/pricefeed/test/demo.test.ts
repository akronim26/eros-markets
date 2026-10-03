import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoObservation, expectedDemoTwap, type DemoDomain } from '../scripts/demo-packet.js';
import type { PollResult } from '../src/worker.js';
import { sourceTime } from '../src/time.js';

const domain:DemoDomain={chainId:31337n,marketId:'0x'+'01'.repeat(32),sourceId:'0x'+'02'.repeat(32),sourceRulesHash:'0x'+'03'.repeat(32)};
const result:PollResult={worker:'test',category:'crypto',atMs:1000100n,configDigest:'test',event:null,metadata:null,book:null,
  baselineRulesDigest:'test',lastSourceMs:1000000n,inspection:{status:'COLLECTING',reason:null,
    time:sourceTime('1000000',1000100n,null,1000n),summary:{valid:true,reason:null,impactBidWad:600000000000000000n,
      impactAskWad:620000000000000000n,priceWad:610000000000000000n,bidDepthLots:2000000n,askDepthLots:3000000n},engineObservation:null}};

test('demo builder preserves authentic time, summary and exact source/domain identifiers',()=>{
  const obs=demoObservation(result,domain,1n,1000900n);
  assert.equal(obs.observedAt,1000n);assert.equal(obs.publishedAt,1000n);assert.equal(obs.priceWad,610000000000000000n);
  assert.equal(obs.sourceId,domain.sourceId);assert.equal(obs.bidDepthLots,2000000n);
  assert.throws(()=>demoObservation(result,{...domain,chainId:1n} as unknown as DemoDomain,1n,1000900n),/LOCAL_DEMO_CHAIN/);
});
test('demo refuses expired, unavailable, invalid and exhausted observations rather than inventing time/price',()=>{
  assert.throws(()=>demoObservation(result,domain,1n,1031000n),/EXPIRED/);
  assert.throws(()=>demoObservation(result,domain,1n,999999n),/EXPIRED/);
  assert.throws(()=>demoObservation({...result,inspection:{...result.inspection,status:'DEGRADED'}},domain,1n,1000900n),/NO_TRUSTED/);
  assert.throws(()=>demoObservation({...result,inspection:{...result.inspection,status:'INVALID_DEPTH'}},domain,1n,1000900n),/NO_TRUSTED/);
  assert.throws(()=>demoObservation(result,domain,1n<<64n,1000900n),/EXHAUSTED/);
});
test('independent demo TWAP verifies price changes, full coverage and integer midpoint rounding',()=>{
  const samples=Array.from({length:10},(_,i)=>({t:700n+BigInt(i)*30n,price:i<5?600000000000000000n:620000000000000000n,valid:true}));
  assert.deepEqual(expectedDemoTwap(samples,1000n),{available:true,twapWad:610000000000000000n,coveredSecs:300n,integral:183000000000000000000n});
});
test('independent demo TWAP exposes a stale gap and invalid transition',()=>{
  const samples=Array.from({length:10},(_,i)=>({t:700n+BigInt(i)*30n,price:600000000000000000n,valid:true}));
  assert.equal(expectedDemoTwap(samples.filter(s=>s.t!==850n),1000n).coveredSecs,270n);
  assert.equal(expectedDemoTwap([...samples,{t:990n,price:0n,valid:false}],1000n).coveredSecs,290n);
  assert.equal(expectedDemoTwap(samples.filter(s=>s.t!==850n),1000n).available,false);
});
test('same-second sample replaces the previous price without adding duplicate coverage',()=>{
  const actual=expectedDemoTwap([{t:990n,price:600000000000000000n,valid:true},{t:990n,price:620000000000000000n,valid:true}],1000n);
  assert.equal(actual.coveredSecs,10n);assert.equal(actual.integral,6200000000000000000n);
});
