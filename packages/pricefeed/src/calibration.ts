import { createHash } from 'node:crypto';
import { record } from './book.js';
import { inspectSnapshot, metadataIdentity, verifyEventMembership } from './collector.js';
import type { MarketConfig } from './config.js';
import { json, uint, WAD } from './math.js';
import { ensureUniqueWorkers, type PollResult } from './worker.js';

export type CalibrationPlan={schemaVersion:'1';depthNLots:string[];maxSpreadWad:string[];
  deliveryBudgetsMs:string[];safetyMarginMs:string;windowMs:'300000'};

/** Explicit diagnostic scenarios, never runtime defaults or approved listing changes. */
export function parseCalibrationPlan(value:unknown):CalibrationPlan {
  const p=record(value);
  const list=(value:unknown,max:bigint,positive:boolean)=>{
    if(!Array.isArray(value)||!value.length||value.length>8)throw new Error('BAD_CALIBRATION_GRID');
    for(const v of value){uint(v,256);if(BigInt(v)>max||(positive&&BigInt(v)===0n))throw new Error('BAD_CALIBRATION_GRID');}
    if(new Set(value).size!==value.length)throw new Error('BAD_CALIBRATION_GRID');
    return value as string[];
  };
  if(p.schemaVersion!=='1'||p.windowMs!=='300000')throw new Error('BAD_CALIBRATION_PLAN');
  uint(p.safetyMarginMs,64);if(BigInt(String(p.safetyMarginMs))>30000n)throw new Error('BAD_CALIBRATION_PLAN');
  return {schemaVersion:'1',depthNLots:list(p.depthNLots,(1n<<256n)-1n,true),maxSpreadWad:list(p.maxSpreadWad,WAD,false),
    deliveryBudgetsMs:list(p.deliveryBudgetsMs,30000n,false),safetyMarginMs:p.safetyMarginMs as string,windowMs:'300000'};
}

function stats(values:bigint[]){
  const sorted=[...values].sort((a,b)=>a<b?-1:a>b?1:0);
  const rank=(p:number)=>sorted[Math.ceil(sorted.length*p/100)-1]?.toString()??null;
  return {count:sorted.length,min:sorted[0]?.toString()??null,p50:rank(50),p95:rank(95),max:sorted.at(-1)?.toString()??null};
}
function count(target:Record<string,number>,key:string){target[key]=(target[key]??0)+1;}
function body(capture:NonNullable<PollResult['book']>){
  const raw=record(JSON.parse(capture.body));
  if(json(raw)!==json(capture.data))throw new Error('CALIBRATION_RAW_BODY_MISMATCH');
  if(capture.receivedAtMs<0n||capture.latencyMs<0n)throw new Error('CALIBRATION_BAD_CAPTURE_TIME');
  return raw;
}

/** Recompute every grid cell from raw archived books, with original vendor times.
 * Coverage is a source-side counterfactual with a fixed delivery delay, NOT engine readiness.
 * Every archived unavailable/invalid decision cuts the previous projected interval.
 */
export function calibrate(configs:MarketConfig[],plan:CalibrationPlan,captures:PollResult[],windowEndMs:bigint){
  ensureUniqueWorkers(configs);parseCalibrationPlan(plan);
  if(!configs.length||configs.length>100||configs.some(c=>c.enabled||c.destination!==null||c.pricing.impactMethod!=='vwap'))
    throw new Error('CALIBRATION_READ_ONLY_VWAP_REQUIRED');
  if(windowEndMs<300000n||!captures.length||captures.some(r=>!configs.some(c=>c.key===r.worker)))throw new Error('CALIBRATION_BAD_ARCHIVE');
  const windowStartMs=windowEndMs-300000n;
  const markets=configs.map(cfg=>{
    const rows=captures.filter(r=>r.worker===cfg.key),digest=createHash('sha256').update(json(cfg)).digest('hex');
    if(!rows.length)throw new Error('CALIBRATION_EMPTY_WORKER');
    const statuses:Record<string,number>={},reasons:Record<string,number>={},ages:bigint[]=[],headrooms:bigint[]=[],latencies:bigint[]=[],gaps:bigint[]=[];
    const requests=new Map<string,number>();let previous:bigint|null=null,advances=0,repeats=0;
    for(let i=0;i<rows.length;i++){
      const row=rows[i]!;
      if(row.configDigest!==digest||row.category!==cfg.category||row.inspection.engineObservation!==null||row.atMs>windowEndMs
        ||(i>0&&row.atMs<rows[i-1]!.atMs))throw new Error('CALIBRATION_ARCHIVE_IDENTITY_OR_TIME');
      count(statuses,row.inspection.status);if(row.inspection.reason)count(reasons,row.inspection.reason);
      if(i)gaps.push(row.atMs-rows[i-1]!.atMs);
      for(const field of ['event','metadata','book'] as const){const c=row[field];if(c){body(c);
        if(c.receivedAtMs>row.atMs)throw new Error('CALIBRATION_BAD_CAPTURE_TIME');
        requests.set(`${field}:${c.url}:${c.receivedAtMs}:${createHash('sha256').update(c.body).digest('hex')}`,c.attempts);}}
      if(row.book){latencies.push(row.book.latencyMs);const raw=body(row.book);
        if(raw.market!==cfg.mapping.conditionId||raw.asset_id!==cfg.mapping.outcomeTokenId)throw new Error('CALIBRATION_BOOK_IDENTITY');
        if(typeof raw.timestamp==='string'&&/^\d{1,23}$/.test(raw.timestamp)){
          const stamp=BigInt(raw.timestamp);ages.push(row.atMs-stamp);headrooms.push((stamp/1000n+30n)*1000n-row.atMs);
          if(previous===null||stamp>previous)advances++;else if(stamp===previous)repeats++;
          if(previous===null||stamp>=previous)previous=stamp;
        }
      }
    }
    const candidates=[];
    for(const depthNLots of plan.depthNLots)for(const maxSpreadWad of plan.maxSpreadWad){
      const candidate={...cfg,pricing:{...cfg.pricing,depthNLots,maxSpreadWad}};
      let lastSource:bigint|null=null,baseline:string|null=null;
      const spreads:bigint[]=[],bidDepths:bigint[]=[],askDepths:bigint[]=[];
      const samples=rows.map(row=>{
        let reason:string|null=row.inspection.reason,expiry:bigint|null=null;
        // Quarantine and stream resync are real decisions; a different N cannot remove them.
        if(row.inspection.status==='QUARANTINED'||reason==='STREAM_RESYNC_REQUIRED')return {row,reason:reason??'QUARANTINED',expiry};
        if(!row.book||!row.event||!row.metadata)return {row,reason:reason??'SOURCE_GAP',expiry};
        try{
          const event=verifyEventMembership(cfg,body(row.event)),market=metadataIdentity(cfg,body(row.metadata));
          const rules=createHash('sha256').update(`${event.rulesDigest}:${market.rulesDigest}`).digest('hex');
          const metadataAt=row.event.receivedAtMs<row.metadata.receivedAtMs?row.event.receivedAtMs:row.metadata.receivedAtMs;
          const inspection=inspectSnapshot(candidate,body(row.book),row.book.receivedAtMs,lastSource,
            {tradeable:event.tradeable&&market.tradeable,rulesDigest:rules},metadataAt,baseline??undefined);
          if(inspection.summary){bidDepths.push(inspection.summary.bidDepthLots);askDepths.push(inspection.summary.askDepthLots);
            if(inspection.summary.impactBidWad!==null&&inspection.summary.impactAskWad!==null)
              spreads.push(inspection.summary.impactAskWad-inspection.summary.impactBidWad);}
          if(baseline===null)baseline=rules;
          if(inspection.time?.monotone)lastSource=inspection.time.sourceMs;
          reason=inspection.reason;
          if(inspection.status==='COLLECTING')expiry=(inspection.time!.observedAt+30n)*1000n;
        }catch{reason='RAW_EVIDENCE_REJECTED';}
        return {row,reason,expiry};
      });
      for(const deliveryBudgetMs of plan.deliveryBudgetsMs){
        const budget=BigInt(deliveryBudgetMs),margin=BigInt(plan.safetyMarginMs),failures:Record<string,number>={};
        let coverage=0n,usable=0,validBooks=0;const remaining:bigint[]=[];
        samples.forEach((sample,i)=>{
          const ready=sample.row.atMs+budget;
          if(sample.expiry!==null)validBooks++;
          let reason=sample.reason;
          if(sample.expiry!==null&&sample.expiry-ready<margin)reason='DELIVERY_BUDGET_EXHAUSTED';
          if(reason===null&&sample.expiry!==null){
            usable++;remaining.push(sample.expiry-ready);
            const left=ready>windowStartMs?ready:windowStartMs;
            const next=samples[i+1]?.row.atMs;
            const right0=next===undefined?windowEndMs:next+budget;
            const right1=right0<sample.expiry?right0:sample.expiry;
            const right=right1<windowEndMs?right1:windowEndMs;
            if(right>left)coverage+=right-left;
          }else count(failures,reason??'SOURCE_GAP');
        });
        candidates.push({depthNLots,maxSpreadWad,deliveryBudgetMs,validBooks,usableCaptures:usable,reasonCounts:failures,
          projectedCoverageMs:coverage.toString(),projectedCoverageBps:(coverage*10000n/300000n).toString(),headroomAfterBudgetMs:stats(remaining),
          impactSpreadWad:stats(spreads),bidDepthLots:stats(bidDepths),askDepthLots:stats(askDepths)});
      }
    }
    return {worker:cfg.key,category:cfg.category,mapping:cfg.mapping,configDigest:digest,captures:rows.length,
      firstCaptureMs:rows[0]!.atMs.toString(),lastCaptureMs:rows.at(-1)!.atMs.toString(),statusCounts:statuses,reasonCounts:reasons,
      sourceAdvances:advances,sourceRepeats:repeats,sourceAgeAtDecisionMs:stats(ages),headroomAtDecisionMs:stats(headrooms),
      bookLatencyMs:stats(latencies),pollCompletionGapsMs:stats(gaps),uniqueRequestCaptures:requests.size,
      successfulRequestAttempts:[...requests.values()].reduce((a,b)=>a+b,0),candidates};
  });
  return {mode:'READ_ONLY_CATEGORY_CALIBRATION',schemaVersion:'1',plan,windowStartMs:windowStartMs.toString(),windowEndMs:windowEndMs.toString(),markets,
    signaturesProduced:0,transactionsSent:0,productionApproved:false,engineCoverageCertified:false,
    assumptions:['Before-fee VWAP: bid floor, ask ceil, midpoint floor; total depth floored to lots.',
      'Fixed delivery budgets are counterfactual inputs, not measured inclusion times.',
      'Unavailable/invalid capture decisions cut projected carry. Repeated vendor time never extends its 30-second expiry.',
      'Raw source quotes/fees/precision and executable fill remain unapproved; own-perp book limits need separate risk review.']};
}
