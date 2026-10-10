import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makerReadinessDelay} from './maker-readiness-policy.mjs';

test('a just-completed rollover is discovered on the next one-second poll',()=>{
  // Noon incident: polling observes rollover before its canonical completion.
  // The historical15s sleep would delay both replacement quotes until+15s.
  const finalizedRolloverAt=250;
  let elapsed=0,polls=0;
  while(elapsed<20000){
    const risk=elapsed<finalizedRolloverAt
      ? {indexAvailable:true,accountingState:1,pendingWork:2}
      : {indexAvailable:true,accountingState:0,pendingWork:0};
    ++polls;
    const delay=makerReadinessDelay(risk);
    if(delay===0)break;
    elapsed+=delay;
  }
  assert.equal(polls,2);
  assert.equal(elapsed,1000);
  assert.ok(elapsed-finalizedRolloverAt<1000);
});

test('missing INDEX preserves long backoff even across rollover completion',()=>{
  for(const accountingState of [0,1,2,3,4])for(const indexAvailable of [false,undefined,null])
    assert.equal(makerReadinessDelay({indexAvailable,accountingState,pendingWork:2}),15000);
  assert.equal(makerReadinessDelay({indexAvailable:true,accountingState:1,pendingWork:2}),1000);
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:1,pendingWork:2}),15000);
});

test('fast polling does not authorize an order; only fresh INDEX and READY removes the wait',()=>{
  for(const accountingState of [0,1,2,3,4,undefined])for(const pendingWork of [0,1,2,3,4,10,undefined]){
    const delay=makerReadinessDelay({indexAvailable:true,accountingState,pendingWork});
    assert.equal(delay===0,accountingState===0);
    if(accountingState!==0)assert.equal(delay,accountingState===1&&(pendingWork===2||pendingWork===10)?1000:15000);
  }
  assert.equal(makerReadinessDelay(undefined),15000);
});

test('a staged risk profile does not restore the15-second rollover delay',()=>{
  assert.equal(makerReadinessDelay({indexAvailable:true,accountingState:1,pendingWork:2|8}),1000);
  assert.equal(makerReadinessDelay({indexAvailable:true,accountingState:1,pendingWork:2|1}),15000);
});

test('a warm-up INDEX point is a quote reference before the INDEX window completes',()=>{
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:0,pendingWork:0},{available:true,pointWad:5n*10n**17n}),0);
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:0,pendingWork:0},{available:false,pointWad:0n}),15000);
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:1,pendingWork:2},{available:true}),1000);
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:3,pendingWork:4},{available:true}),15000);
  assert.equal(makerReadinessDelay({indexAvailable:false,accountingState:0,pendingWork:0}),15000,'older engines');
});
