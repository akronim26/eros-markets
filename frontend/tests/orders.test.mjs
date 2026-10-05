import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderStatus, rememberedOrders, rememberOrders } from '../src/lib/orders.ts';
const order={owner:7,size:1000n,tick:650,flags:5,gen:2,marketEpoch:3n,accountEpoch:4n,reduceVersion:5n,expiryBlock:100};
const context={traderId:7,block:100n,marketEpoch:3n,accountEpoch:4n,positionVersion:5n};
const id=2*2**24+9;
test('resting order remains live through its expiry block',()=>{assert.equal(orderStatus(id,order,context),'live');assert.equal(orderStatus(id,order,{...context,block:101n}),'stale')});
test('generations and ownership prevent cancelling another order',()=>{assert.equal(orderStatus(id,{...order,gen:3},context),'closed');assert.equal(orderStatus(id,{...order,owner:8},context),'foreign')});
test('cancel-all, market invalidation and position changes invalidate orders',()=>{
 for(const patch of [{accountEpoch:5n},{marketEpoch:4n}])assert.equal(orderStatus(id,order,{...context,...patch}),'stale');
 assert.equal(orderStatus(id,{...order,flags:7},{...context,positionVersion:6n}),'stale');
 assert.equal(orderStatus(id,order,{...context,positionVersion:6n}),'live');
});
test('filled and removed orders never appear open',()=>{for(const patch of [{size:0n},{flags:1}])assert.equal(orderStatus(id,{...order,...patch},context),'closed')});
test('receipt discovery isolates chain, market and wallet without storage',()=>{
 rememberOrders(10143,'0xabc','0xdef',[id,id]);assert.deepEqual(rememberedOrders(10143,'0xABC','0xDEF'),[id]);
 for(const args of [[1,'0xabc','0xdef'],[10143,'0x000','0xdef'],[10143,'0xabc','0x000']])assert.deepEqual(rememberedOrders(...args),[]);
});
