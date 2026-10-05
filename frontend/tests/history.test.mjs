import assert from 'node:assert/strict';
import {test} from 'node:test';
import {historyTotals} from '../src/lib/history.ts';
test('history totals use exact units and do not count Fill and PairedPosting twice',()=>{
 const e=(id,kind,payload)=>({id,kind,payload:JSON.stringify(payload)});
 const allocation=e('1','CashAllocated',{atoms:'100000000'});
 const events=[allocation,allocation,e('2','Released',{atoms:'20000000'}),e('3','AccountSynced',{fundingPaymentQ:'-400',premiumQ:'200'}),e('4','Fill',{maker:7,taker:8,makerFeeQ:'11',takerFeeQ:'13'}),e('5','PairedPosting',{feesQ:'24'}),e('6','PairReduction',{target:7,partner:8,feeTargetQ:'31',feePartnerQ:'37'})];
 assert.deepEqual(historyTotals(events,7),{allocated:100000000n,released:20000000n,fundingQ:-400n,premiumQ:200n,feesQ:11n,liquidationFeesQ:31n});
 assert.equal(historyTotals(events,8).feesQ,13n);
 assert.equal(historyTotals(events,8).liquidationFeesQ,37n);
});
