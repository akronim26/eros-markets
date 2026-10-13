import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fundingPlan, amountWithinBalance, atomsToInput, canClaim } from '../src/lib/funds.ts';
test('funding uses existing free funds before depositing or approving',()=>{
 assert.deepEqual(fundingPlan(100n,100n,0n,0n),{approve:0n,deposit:0n,allocate:100n});
 assert.deepEqual(fundingPlan(100n,40n,60n,0n),{approve:60n,deposit:60n,allocate:100n});
 assert.deepEqual(fundingPlan(100n,40n,60n,60n),{approve:0n,deposit:60n,allocate:100n});
});
test('retry after a completed deposit never deposits twice',()=>{
 const first=fundingPlan(100n,0n,100n,100n);assert.equal(first.deposit,100n);
 assert.deepEqual(fundingPlan(100n,100n,0n,100n),{approve:0n,deposit:0n,allocate:100n});
});
test('zero, negative and excess amounts cannot be submitted',()=>{
 for(const amount of [0n,-1n]){assert.throws(()=>fundingPlan(amount,100n,100n,0n));assert.throws(()=>amountWithinBalance(amount,100n));}
 assert.throws(()=>fundingPlan(201n,100n,100n,999n));assert.throws(()=>amountWithinBalance(101n,100n));
 assert.equal(amountWithinBalance(100n,100n),100n);assert.equal(atomsToInput(1234567890123456789n),'1234567890123.456789');
});
test('oracle finality alone never enables payout; zero and recovery are blocked; later reserve credits remain claimable',()=>{
 const status={halted:true,claimsEnabled:true,recoveryRequired:false};assert.equal(canClaim(status,1n,false),true);
 for(const s of [undefined,{...status,halted:false},{...status,claimsEnabled:false},{...status,recoveryRequired:true}])assert.equal(canClaim(s,1n,false),false);
 assert.equal(canClaim(status,0n,false),false);assert.equal(canClaim(status,1n,true),true);
});
