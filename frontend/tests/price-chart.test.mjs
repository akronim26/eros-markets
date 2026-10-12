import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSegments } from '../src/lib/price-chart.ts';
const point=(t,v=0.5,valid=true)=>({t,v,valid,block:BigInt(t)});
test('chart retains invalid source intervals and stale gaps instead of drawing continuous prices',()=>{
 // 141 - 20 = 121 s exceeds the 120 s testnet INDEX carry.
 const segments=priceSegments([point(1),point(11),point(12,0,false),point(20),point(141),point(151)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.t)),[[1,11],[20],[141,151]]);
 assert.ok(segments.flat().every(p=>p.v===0.5));
});
test('chart accepts genuine zero and one while breaking at malformed or reversed history',()=>{
 const segments=priceSegments([point(1,0),point(2,1),point(3,NaN),point(4),point(3)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.v)),[[0,1],[0.5],[0.5]]);
});
test('paced 80 s observations draw one continuous line',()=>{
 const segments=priceSegments([point(0),point(80),point(160),point(280)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.t)),[[0,80,160,280]]);
});
