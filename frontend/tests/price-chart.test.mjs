import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceBridges, priceSegments } from '../src/lib/price-chart.ts';
const point=(t,v=0.5,valid=true)=>({t,v,valid,block:BigInt(t)});
test('chart holds the last valid price across invalid readings within the carry and breaks at stale gaps',()=>{
 // 141 - 20 = 121 s exceeds the 120 s testnet INDEX carry.
 const segments=priceSegments([point(1),point(11,0.6),point(12,0,false),point(20),point(141),point(151)]);
 assert.deepEqual(segments.map(s=>s.map(p=>[p.t,p.v])),[[[1,0.5],[11,0.6],[12,0.6],[20,0.5]],[[141,0.5],[151,0.5]]]);
});
test('chart accepts genuine zero and one while breaking at malformed or reversed history',()=>{
 const segments=priceSegments([point(1,0),point(2,1),point(3,NaN),point(4),point(3)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.v)),[[0,1],[0.5],[0.5]]);
});
test('paced 80 s observations draw one continuous line',()=>{
 const segments=priceSegments([point(0),point(80),point(160),point(280)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.t)),[[0,80,160,280]]);
});
test('short invalid stretches are drawn at the last valid price, without a bridge',()=>{
 const points=[point(1),point(11,0.6),point(12,0,false),point(20,0.7),point(25,0,false),point(28,0,false),point(40,0.8)];
 assert.deepEqual(priceSegments(points).map(s=>s.map(p=>[p.t,p.v])),[[[1,0.5],[11,0.6],[12,0.6],[20,0.7],[25,0.7],[28,0.7],[40,0.8]]]);
 assert.deepEqual(priceBridges(points),[]);
});
test('an invalid stretch past the carry breaks the line and is bridged',()=>{
 // 60 s is held; 130 s is past the carry from the last valid reading at 0.
 const points=[point(0),point(60,0,false),point(130,0,false),point(140)];
 assert.deepEqual(priceSegments(points).map(s=>s.map(p=>p.t)),[[0,60],[140]]);
 assert.deepEqual(priceBridges(points).map(([a,b])=>[a.t,b.t]),[[0,140]]);
 // A leading invalid reading has no price to hold.
 assert.deepEqual(priceSegments([point(0,0,false),point(5)]).map(s=>s.map(p=>p.t)),[[5]]);
});
test('bridges span outages of any length but never malformed or reversed history',()=>{
 // 1 -> 141: a 140 s stale gap (publisher outage) is bridged; the solid line still breaks there.
 assert.deepEqual(priceBridges([point(1),point(141)]).map(([a,b])=>[a.t,b.t]),[[1,141]]);
 assert.deepEqual(priceSegments([point(1),point(141)]).map(s=>s.map(p=>p.t)),[[1],[141]]);
 // A 52-minute outage is bridged too.
 assert.deepEqual(priceBridges([point(0),point(3120)]).map(([a,b])=>[a.t,b.t]),[[0,3120]]);
 // 10 -> 131 across an invalid reading is bridged.
 assert.deepEqual(priceBridges([point(10),point(50,0,false),point(131)]).map(([a,b])=>[a.t,b.t]),[[10,131]]);
 // Readings inside the carry are already joined by the solid line: no bridge.
 assert.deepEqual(priceBridges([point(0),point(60),point(120)]),[]);
 // A malformed reading after the invalid one forgets the left end.
 assert.deepEqual(priceBridges([point(1),point(2,0,false),point(3,NaN),point(4)]),[]);
 // The right end must be later than the left end.
 assert.deepEqual(priceBridges([point(10),point(11,0,false),point(9)]),[]);
 // Exactly the 120 s carry across an invalid reading stays solid: no bridge.
 assert.deepEqual(priceBridges([point(0),point(60,0,false),point(120)]),[]);
 assert.deepEqual(priceSegments([point(0),point(60,0,false),point(120)]).map(s=>s.map(p=>p.t)),[[0,60,120]]);
});
