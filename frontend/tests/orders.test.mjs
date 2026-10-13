import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderStatus, openOrdersAt, rememberedOrders, rememberOrders } from '../src/lib/orders.ts';
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
test('cancel-all removes logically cancelled rows before physical book pruning',()=>{
 // Canonical local browser reproduction: cancellation moved trader7 from epoch1 to2
 // while both physical nodes retained their size and active bit.
 const nodes=[{id:67108866,owner:7,size:2000n,tick:480,flags:5,gen:4,marketEpoch:3n,accountEpoch:1n,reduceVersion:0n,expiryBlock:0},
   {id:50331651,owner:7,size:2000n,tick:481,flags:5,gen:3,marketEpoch:3n,accountEpoch:1n,reduceVersion:0n,expiryBlock:0}];
 const before={traderId:7,block:2417n,marketEpoch:3n,accountEpoch:1n,positionVersion:0n};
 assert.equal(openOrdersAt(nodes,before).length,2);
 const after={...before,block:2418n,accountEpoch:2n};
 assert.deepEqual(openOrdersAt(nodes,after),[]);
 const fresh={...nodes[0],id:50331652,gen:3,accountEpoch:2n};
 assert.deepEqual(openOrdersAt([...nodes,fresh],after).map(o=>o.id),[fresh.id]);
});
test('open-order rows exclude expired, invalidated, foreign and recycled nodes',()=>{
 const base={id,...order};
 for(const patch of [{marketEpoch:2n},{accountEpoch:3n},{expiryBlock:99},{flags:7,reduceVersion:4n},{owner:8},{gen:3},{size:0n}])
  assert.deepEqual(openOrdersAt([{...base,...patch}],context),[]);
 assert.deepEqual(openOrdersAt([base],context).map(o=>o.id),[id]);
});
test('receipt discovery isolates chain, market and wallet without storage',()=>{
 rememberOrders(10143,'0xabc','0xdef',[id,id]);assert.deepEqual(rememberedOrders(10143,'0xABC','0xDEF'),[id]);
 for(const args of [[1,'0xabc','0xdef'],[10143,'0x000','0xdef'],[10143,'0xabc','0x000']])assert.deepEqual(rememberedOrders(...args),[]);
});
