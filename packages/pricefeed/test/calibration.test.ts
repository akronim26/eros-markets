import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrate, parseCalibrationPlan } from '../src/calibration.js';
import { base } from './publication-fixture.js';
import { Worker, type PollResult } from '../src/worker.js';
import { Journal } from '../src/journal.js';
import { json } from '../src/math.js';

const plan=parseCalibrationPlan({schemaVersion:'1',depthNLots:['5000','10000'],maxSpreadWad:['20000000000000000','50000000000000000'],
  deliveryBudgetsMs:['0','5000'],safetyMarginMs:'1000',windowMs:'300000'});

async function fixture(options:{repeated?:boolean;gapAt?:number;invalidAt?:number;restart?:boolean;review?:boolean}={}){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-calibration-'));let journal=new Journal(join(dir,'source.sqlite')),now=1000000n;
  let closed=false;
  const configs=(['crypto','sports','politics'] as const).map((category,index)=>({...base,key:`cal-${category}`,category,destination:null,
    pricing:{...base.pricing,depthNLots:'5000'},mapping:{...base.mapping,eventId:String(index+1),externalMarketId:String(index+11),
      conditionId:'0x'+String(index+1).repeat(64),outcomeTokenId:String(index+21)}}));
  let round=0;
  const makeWorkers=()=>configs.map(cfg=>new Worker(cfg,{
    event:async()=>capture({id:cfg.mapping.eventId,active:true,closed:false,markets:[{id:cfg.mapping.externalMarketId}]}),
    metadata:async()=>capture({id:cfg.mapping.externalMarketId,conditionId:cfg.mapping.conditionId,question:'Fixture',description:'Rules',
      outcomes:['Yes','No'],clobTokenIds:[cfg.mapping.outcomeTokenId,'999'],active:true,closed:false,enableOrderBook:true,acceptingOrders:true}),
    book:async()=>{if(round===options.gapAt)throw new Error('SOURCE_TIMEOUT');
      return capture({market:cfg.mapping.conditionId,asset_id:cfg.mapping.outcomeTokenId,hash:'fixture',
        timestamp:String(options.repeated?1000000n:now),tick_size:'0.01',min_order_size:'5',
        bids:[{price:'0.60',size:round===options.invalidAt?'4.999':'6'},{price:'0.58',size:round===options.invalidAt?'0':'4'}],
        asks:[{price:'0.62',size:'6'},{price:'0.64',size:'4'}]});},
  },journal,'fixture-'+(now===1000000n?'first':'restart'),()=>now));
  function capture(data:Record<string,unknown>){return {url:'https://fixture.invalid',receivedAtMs:now,latencyMs:1n,body:JSON.stringify(data),data,headers:{},attempts:1};}
  let workers=makeWorkers();const rows:PollResult[]=[];
  try{
    for(round=0;round<30;round++){now=1000000n+BigInt(round)*10000n;
      if(round===15&&options.restart){workers.forEach(w=>w.releaseLease());journal.close();journal=new Journal(join(dir,'source.sqlite'));workers=makeWorkers();}
      rows.push(...await Promise.all(workers.map(w=>w.poll())));}
    assert.equal(journal.verify(),true);const report=calibrate(configs,plan,rows,1300000n);
    if(options.review){
      workers.forEach(w=>w.releaseLease());journal.close();closed=true;
      const db=join(dir,'source.sqlite'),cfg=join(dir,'configs.json'),pl=join(dir,'plan.json'),out=join(dir,'report.json');
      writeFileSync(cfg,json(configs));writeFileSync(pl,json(plan));
      const retained={...report,sourceArchiveSha256:createHash('sha256').update(readFileSync(db)).digest('hex'),
        configsSha256:createHash('sha256').update(json(configs)).digest('hex')};
      writeFileSync(out,json(retained));
      const review=()=>spawnSync('python3',[fileURLToPath(new URL('../../scripts/review-calibration.py',import.meta.url)),db,out,cfg,pl],{encoding:'utf8'});
      const valid=review();assert.equal(valid.status,0,valid.stderr);
      assert.equal(JSON.parse(valid.stdout).gridCellsChecked,24);
      retained.markets[0]!.candidates[0]!.projectedCoverageMs='299999';writeFileSync(out,json(retained));
      assert.notEqual(review().status,0,'Independent replay must reject a changed coverage result');
    }
    return {configs,rows,report};
  }finally{if(!closed){workers.forEach(w=>w.releaseLease());journal.close();}rmSync(dir,{recursive:true,force:true});}
}

test('calibration compares exact N/spread and fixed-delay source availability across three restarted workers',async()=>{
  const {report}=await fixture({restart:true});assert.equal(report.markets.length,3);
  for(const market of report.markets){
    assert.equal(market.captures,30);assert.equal(market.sourceAdvances,30);
    const at=(n:string,s:string,b:string)=>market.candidates.find(c=>c.depthNLots===n&&c.maxSpreadWad===s&&c.deliveryBudgetMs===b)!;
    // Five-claim book: 0.60 / 0.62. Ten-claim VWAP: 0.592 / 0.628 => 0.036 spread.
    assert.equal(at('5000','20000000000000000','0').projectedCoverageMs,'300000');
    assert.equal(at('5000','20000000000000000','5000').projectedCoverageMs,'295000');
    assert.equal(at('10000','20000000000000000','0').projectedCoverageMs,'0');
    assert.equal(at('10000','50000000000000000','0').impactSpreadWad.min,'36000000000000000');
    assert.equal(at('10000','50000000000000000','0').projectedCoverageMs,'300000');
  }
  assert.equal(report.engineCoverageCertified,false);assert.equal(report.productionApproved,false);
  assert.equal(report.transactionsSent,0);assert.equal(report.signaturesProduced,0);
});

test('unchanged vendor time, source gaps and invalid depth cut projected carry truthfully',async()=>{
  const repeated=await fixture({repeated:true});
  for(const m of repeated.report.markets){assert.equal(m.sourceRepeats,29);assert.equal(m.candidates[0]!.projectedCoverageMs,'30000');}
  const gap=await fixture({gapAt:15});for(const m of gap.report.markets)assert.equal(m.candidates[0]!.projectedCoverageMs,'290000');
  const thin=await fixture({invalidAt:15});for(const m of thin.report.markets){assert.equal(m.candidates[0]!.projectedCoverageMs,'290000');
    assert.equal(m.candidates[0]!.reasonCounts.INSUFFICIENT_DEPTH,1);}
});

test('calibration refuses altered evidence, backwards archive time, enabled destinations and unsafe grids',async()=>{
  const {configs,rows}=await fixture();
  const changed=rows.map(r=>({...r}));changed[0]={...changed[0]!,configDigest:'wrong'};
  assert.throws(()=>calibrate(configs,plan,changed,1300000n),/ARCHIVE_IDENTITY/);
  const corrupt=rows.map(r=>({...r,book:r.book?{...r.book}:null}));corrupt[0]!.book!.body='{}';
  assert.throws(()=>calibrate(configs,plan,corrupt,1300000n),/RAW_BODY_MISMATCH/);
  const reversed=[...rows].reverse();assert.throws(()=>calibrate(configs,plan,reversed,1300000n),/ARCHIVE_IDENTITY_OR_TIME/);
  assert.throws(()=>calibrate([{...configs[0]!,enabled:true}],plan,rows,1300000n),/READ_ONLY/);
  for(const change of [{depthNLots:['0']},{depthNLots:['5000','5000']},{deliveryBudgetsMs:['30001']},
    {maxSpreadWad:['1000000000000000001']},{safetyMarginMs:'30001'},{windowMs:'299999'}])
    assert.throws(()=>parseCalibrationPlan({...plan,...change}),/CALIBRATION/);
});

test('quarantine cannot become usable by lowering N or widening spread',async()=>{
  const {configs,rows}=await fixture();
  const before=json(configs);
  const quarantined=rows.map(r=>({...r,inspection:{...r.inspection,status:'QUARANTINED' as const,reason:'SOURCE_STATUS_CHANGED_REVIEW_REQUIRED'}}));
  const report=calibrate(configs,plan,quarantined,1300000n);
  assert.ok(report.markets.every(m=>m.candidates.every(c=>c.projectedCoverageMs==='0'&&c.usableCaptures===0)));
  assert.equal(json(configs),before);
});

test('independent Fraction/archive replay verifies all cells and rejects changed results',async()=>{
  await fixture({restart:true,gapAt:20,invalidAt:22,review:true});
});

test('one extra lot and below-minimum quantities remain unavailable in calibration',async()=>{
  const {configs,rows}=await fixture();
  const boundary=calibrate(configs,{...plan,depthNLots:['10001','4999']},rows,1300000n);
  assert.ok(boundary.markets.every(m=>m.candidates.every(c=>c.usableCaptures===0)));
  assert.equal(boundary.markets[0]!.candidates[0]!.reasonCounts.INSUFFICIENT_DEPTH,30);
  assert.equal(boundary.markets[0]!.candidates[4]!.reasonCounts.BELOW_SOURCE_MINIMUM,30);
});
