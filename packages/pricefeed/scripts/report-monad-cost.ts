/** Reproducible capacity scenarios; no RPC, keys, scheduling or transaction permission. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { feedCost } from '../src/cost.js';
import { sizeGas } from '../src/gas.js';
import { json } from '../src/math.js';
import { parseTestnetRunPolicy } from '../src/monad-service.js';

const root='artifacts/monad-testnet/',quoteBytes=readFileSync(root+'gas-quote.json');
const quote=JSON.parse(quoteBytes.toString()),pilot=JSON.parse(readFileSync(root+'publication-pilot.json','utf8'));
const rawPolicy=JSON.parse(readFileSync(root+'publication-policy.json','utf8')),policy=parseTestnetRunPolicy(rawPolicy);
assert.equal(quote.mode,'MONAD_TESTNET_GAS_QUOTE');assert.equal(quote.transactionsSent,0);
assert.equal(quote.nonceBefore,quote.nonceAfter);assert.equal(quote.quotePacketExpired,true);
const sizing=sizeGas(BigInt(quote.sizing.estimatedGas),policy.relay.gasCap,BigInt(quote.sizing.marginBps));
assert.equal(sizing.gasLimit.toString(),quote.sizing.gasLimit);
// Historical paid price, explicitly a scenario rather than a current fee forecast.
const historicalPrice=BigInt(pilot.receipts.at(-1).effectiveGasPrice);
const daily=[1,3].flatMap(markets=>[5,10,15,20].map(intervalSeconds=>({
  atPilotPrice:feedCost(sizing.gasLimit,historicalPrice,markets,intervalSeconds,86400),
  atMaxFee:feedCost(sizing.gasLimit,policy.relay.maxFeePerGas,markets,intervalSeconds,86400),
  oldLimitAtPilotPrice:feedCost(policy.relay.gasCap,historicalPrice,markets,intervalSeconds,86400)})));
const planned=feedCost(sizing.gasLimit,historicalPrice,1,5,360);
// Explicit additional envelope, with room above the quote for changed storage paths.
// The gas cap remains historical until a versioned transition can reconcile old requests.
const additionalTransactions=84,additionalReservationWei=2772000000000000000n;
const existingReservedWei=pilot.restartedRun.packets.reduce((sum:bigint,p:any)=>
  sum+BigInt(p.delivery.request.gas)*BigInt(p.delivery.request.maxFeePerGas),0n);
const balance=BigInt(quote.senderBalanceWei),fundingGapWei=additionalReservationWei>balance?additionalReservationWei-balance:0n;
const proposedPolicy={...rawPolicy,relay:{...rawPolicy.relay,gasSafetyMarginBps:'1000'},
  budget:{maxTransactions:pilot.transactionsFinalized+additionalTransactions,
    totalMaxCostWei:(existingReservedWei+additionalReservationWei).toString()}};
parseTestnetRunPolicy(proposedPolicy);
const report={mode:'MONAD_TESTNET_COST_CAPACITY_SCENARIOS',quoteSha256:createHash('sha256').update(quoteBytes).digest('hex'),
  quoteSequence:quote.sequence,sizing,historicalPaidGasPriceWei:historicalPrice,maxFeePerGasWei:policy.relay.maxFeePerGas,
  limitReductionBps:(policy.relay.gasCap-sizing.gasLimit)*10000n/policy.relay.gasCap,
  daily,proposedCampaign:{durationSeconds:360,pollIntervalMs:5000,nominalSubmissions:planned.submissions,
    estimatedCostAtPilotPriceWei:planned.totalCostWei,
    estimatedReservationAtQuoteLimitWei:feedCost(sizing.gasLimit,policy.relay.maxFeePerGas,1,5,360).totalCostWei,
    additionalTransactions,additionalReservationWei,existingReservedWei,observedBalanceWei:balance,fundingGapWei,
    suggestedTopUpWei:2500000000000000000n,proposedPolicy,activated:false,
    prerequisites:['Implement and verify an explicit idle-journal policy/budget transition preserving all signed history.',
      'Fund the existing sender and authorize the finite additional spend envelope.',
      'Recheck source/listing identity, estimates, balance, nonce and headroom immediately before running.'],
    successCriteria:['Finalized, canonical authenticated packets for the entire evaluated 300-second window.',
      'Independent source-time/Fraction replay agrees with the receiver TWAP at a named finalized block.',
      'Report actual source gaps, invalid checkpoints, receipt latency, retries and charged gas; retain failed windows.']},
  productionApproved:false,cadenceApproved:false,
  limitations:['One simulated valid politics packet; actual optimized charged cost has not been measured.',
    'One/three-market daily cases assume this same gas per packet; other categories/storage paths need measurements.',
    'Five-second polling is a diagnostic candidate based on earlier local coverage, not a promised submission interval.',
    'Nominal costs exclude outages and additional paid transactions. Unknown-send retries reuse the same signed nonce.',
    'The additional envelope bounds aggregate reservations even if estimates rise; coverage can fail before the transaction count is reached.',
    'No policy transition, funding or external transaction is performed by this report.']};
writeFileSync(root+'cost-capacity.json',json(report)+'\n');
console.log(json({sizing,nominalCampaignCostWei:planned.totalCostWei,fundingGapWei,activated:false}));
