import type { Observation } from '../src/wire.js';
import type { PollResult } from '../src/worker.js';
import { sourceTime } from '../src/time.js';
import { UINT64_MAX } from '../src/math.js';

export type DemoDomain={chainId:31337n;marketId:string;sourceId:string;sourceRulesHash:string};

// Separate test/demo builder. Operational config admission remains unchanged.
export function demoObservation(result:PollResult,domain:DemoDomain,sequence:bigint,publishedAtMs:bigint):Observation {
  if(domain.chainId!==31337n)throw new Error('LOCAL_DEMO_CHAIN_REQUIRED');
  const {inspection}=result,summary=inspection.summary,time=inspection.time;
  if(inspection.status!=='COLLECTING'||!time||!summary?.valid||summary.priceWad===null
    ||summary.impactBidWad===null||summary.impactAskWad===null)throw new Error('NO_TRUSTED_DEMO_OBSERVATION');
  const checked=sourceTime(time.sourceMs.toString(),publishedAtMs,time.sourceMs,1000n);
  if(!checked.fresh||!checked.hasHeadroom)throw new Error('DEMO_PACKET_EXPIRED');
  if(sequence<1n||sequence>UINT64_MAX)throw new Error('DEMO_SEQUENCE_EXHAUSTED');
  return {marketId:domain.marketId,sourceId:domain.sourceId,sourceRulesHash:domain.sourceRulesHash,
    sequence,observedAt:time.observedAt,publishedAt:publishedAtMs/1000n,
    priceWad:summary.priceWad,impactBidWad:summary.impactBidWad,
    impactAskWad:summary.impactAskWad,bidDepthLots:summary.bidDepthLots,askDepthLots:summary.askDepthLots};
}

export type DemoSample={t:bigint;price:bigint;valid:boolean};
// Independent direct time-segment integration; never calls risk math to derive expected values.
export function expectedDemoTwap(samples:DemoSample[],end:bigint) {
  const byTime=new Map<bigint,DemoSample>();for(const sample of samples)byTime.set(sample.t,sample);
  const ordered=[...byTime.values()].sort((a,b)=>a.t<b.t?-1:a.t>b.t?1:0);
  const start=end-300n;let coveredSecs=0n,integral=0n;
  for(let i=0;i<ordered.length;i++){
    const sample=ordered[i]!;if(!sample.valid||sample.t>end)continue;
    const from=sample.t>start?sample.t:start;
    let until=sample.t+30n;const next=ordered[i+1]?.t;
    if(next!==undefined&&next<until)until=next;if(end<until)until=end;
    if(until>from){coveredSecs+=until-from;integral+=(until-from)*sample.price;}
  }
  const available=coveredSecs===300n;
  return {available,twapWad:available?integral/300n:0n,coveredSecs,integral};
}
