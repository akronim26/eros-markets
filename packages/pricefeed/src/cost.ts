import { ceilDiv } from './math.js';
/** Capacity planning only; no scheduling, freshness promise or transaction permission. */
export function feedCost(gasLimit:bigint,gasPriceWei:bigint,markets:number,intervalSeconds:number,durationSeconds:number){
  if(gasLimit<21000n||gasPriceWei<=0n||!Number.isSafeInteger(markets)||markets<1||markets>100000
    ||!Number.isSafeInteger(intervalSeconds)||intervalSeconds<1||intervalSeconds>86400
    ||!Number.isSafeInteger(durationSeconds)||durationSeconds<1||durationSeconds>86400)
    throw new Error('BAD_FEED_COST_INPUT');
  const costPerSubmissionWei=gasLimit*gasPriceWei;
  const submissions=BigInt(markets)*ceilDiv(BigInt(durationSeconds),BigInt(intervalSeconds));
  return {markets,intervalSeconds,durationSeconds,submissions,costPerSubmissionWei,totalCostWei:submissions*costPerSubmissionWei,
    retriesIncluded:false,cadenceApproved:false};
}
