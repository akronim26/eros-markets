import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSegments } from '../src/lib/price-chart.ts';
const point=(t,v=0.5,valid=true)=>({t,v,valid,block:BigInt(t)});
test('chart retains invalid source intervals and stale gaps instead of drawing continuous prices',()=>{
 const segments=priceSegments([point(1),point(11),point(12,0,false),point(20),point(51),point(61)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.t)),[[1,11],[20],[51,61]]);
 assert.ok(segments.flat().every(p=>p.v===0.5));
});
test('chart accepts genuine zero and one while breaking at malformed or reversed history',()=>{
 const segments=priceSegments([point(1,0),point(2,1),point(3,NaN),point(4),point(3)]);
 assert.deepEqual(segments.map(s=>s.map(p=>p.v)),[[0,1],[0.5],[0.5]]);
});
