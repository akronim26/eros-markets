/** Offline proposal based on paid measurements. Does not activate any policy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { json } from '../src/math.js';
import { parseTestnetRunPolicy } from '../src/monad-service.js';

const root='artifacts/monad-testnet/',bytes=readFileSync(root+'optimized-small-run.json');
const baseline=JSON.parse(bytes.toString()),oldRaw=JSON.parse(readFileSync(root+'small-run-policy.json','utf8'));
const old=parseTestnetRunPolicy(oldRaw),prices=baseline.receipts.filter((r:{nonce:number})=>r.nonce>=4);
assert.equal(baseline.mode,'MONAD_TESTNET_OPTIMIZED_GAS_DIAGNOSTIC');assert.equal(prices.length,6);
const historicalReserved=baseline.deliveries.reduce((s:bigint,r:any)=>s+BigInt(r.request.gas)*BigInt(r.request.maxFeePerGas),0n)
  +baseline.recoveries.reduce((s:bigint,r:any)=>s+BigInt(r.reservationWei),0n);
assert.equal(baseline.deliveries.length+baseline.recoveries.length,old.budget.maxTransactions);
const observedBalance=JSON.parse(readFileSync(root+'optimized-final-state.json','utf8'));
const priceCost=prices.reduce((s:bigint,r:any)=>s+BigInt(r.gasCostWei),0n);
const highestLimit=prices.reduce((s:bigint,r:any)=>s>BigInt(r.gasLimit)?s:BigInt(r.gasLimit),0n);
const slots=44,envelope=1350000000000000000n;
const nextRaw={...oldRaw,budget:{maxTransactions:old.budget.maxTransactions+slots,
  totalMaxCostWei:(historicalReserved+envelope).toString(),budgetRevision:(old.budget.budgetRevision??0)+1}};
parseTestnetRunPolicy(nextRaw);
const expectedCost=priceCost*BigInt(slots)/BigInt(prices.length);
const balance=BigInt(observedBalance.balanceWei),gap=envelope>balance?envelope-balance:0n;
const report={mode:'MONAD_TESTNET_SUSTAINED_COVERAGE_PROPOSAL',baselineEvidenceSha256:createHash('sha256').update(bytes).digest('hex'),
  sender:old.sender,oldPolicy:oldRaw,nextPolicy:nextRaw,activated:false,authorized:false,
  historicalReservedWei:historicalReserved,maxAdditionalReservations:slots,remainingReservationCapWei:envelope,
  policyCapIncreaseWei:historicalReserved+envelope-old.budget.totalMaxCostWei,
  observedBalanceWei:balance,balanceObservedAtUtc:observedBalance.checkedAtUtc,fundingGapAtRecordedBalanceWei:gap,
  suggestedTopUpWei:1150000000000000000n,expectedCostFor44PricesAtMeasuredAverageWei:expectedCost,
  reservationFor44PricesAtHighestMeasuredLimitWei:highestLimit*old.relay.maxFeePerGas*BigInt(slots),
  highestMeasuredGasLimit:highestLimit,measuredPriceSamples:prices.length,
  phases:[{phase:'initial',maxNewFinalizedPrices:22,durationCapSeconds:600,requireCoveredSeconds:300},
    {phase:'gap',minimumPauseSeconds:60,requireAvailable:false,requireSourceSequenceUnchanged:true},
    {phase:'recovered',maxNewFinalizedPrices:22,durationCapSeconds:600,requireCoveredSeconds:300,requireWindowEntirelyAfterRestart:true}],
  checkpoints:'Evaluate indexTwap300 at each named canonical finalized block timestamp; keep all failed receipt windows.',
  stopConditions:['Stop at either count or aggregate reservation cap; cancellations consume this same envelope.',
    'Stop on unresolved signed delivery or failed phase. Do not reset journals or silently extend limits.',
    'Apply the exact hashed budget plan only after approval and a fresh balance/nonce/source check.'],
  productionApproved:false,transactionsSent:0,signaturesProduced:0,
  limitations:['44 is a ceiling, not a guaranteed submission count or coverage result.',
    'Measured 17–28 second acceptance intervals can worsen; fresh source gaps remain unavailable.',
    'Estimated cost uses six historical prices; the 1.35 MON bound covers maximum reservations, not a promised charge.',
    'One existing politics listing; no fabricated invalid market books or new production listing approval.']};
writeFileSync(root+'coverage-policy.json',json(nextRaw)+'\n');
writeFileSync(root+'coverage-proposal.json',json(report)+'\n');
console.log(json({prepared:true,activated:false,maxAdditionalReservations:slots,reservationCapWei:envelope,
  expectedCostFor44PricesWei:expectedCost,fundingGapAtRecordedBalanceWei:gap,suggestedTopUpWei:report.suggestedTopUpWei}));
