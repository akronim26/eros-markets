import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sizeGas } from '../src/gas.js';
import { feedCost } from '../src/cost.js';

test('gas sizing rounds upward without clamping to a ceiling or inventing an estimate',()=>{
  assert.deepEqual(sizeGas(100001n,800000n,1000n),{estimatedGas:100001n,gasLimit:110002n,marginBps:1000n});
  for(const value of [undefined,0n,20999n])assert.throws(()=>sizeGas(value,800000n,1000n),/ESTIMATE_REQUIRED/);
  assert.throws(()=>sizeGas(727273n,800000n,1000n),/CAP_EXCEEDED/);
  for(const margin of [0n,99n,5001n])assert.throws(()=>sizeGas(100000n,800000n,margin),/SAFETY_MARGIN/);
});
test('cost planner reproduces measured pilot rates and counts multiple markets and fractional periods exactly',()=>{
  const daily=feedCost(800000n,102000000000n,1,15,86400);
  assert.equal(daily.submissions,5760n);assert.equal(daily.totalCostWei,470016000000000000000n);
  assert.equal(daily.cadenceApproved,false);assert.equal(daily.retriesIncluded,false);
  assert.equal(feedCost(110002n,102000000000n,3,15,301).submissions,63n);
  assert.equal(feedCost(110002n,102000000000n,1,15,300).totalCostWei,224404080000000000n);
  assert.throws(()=>feedCost(21000n,1n,1,0,300),/BAD_FEED_COST_INPUT/);
});
