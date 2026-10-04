/** Evidence replay only. It neither constructs a signer nor changes any journal. */
import assert from 'node:assert/strict';

export type CoverageSample={sequence:bigint;observedAt:bigint;acceptedAt:bigint;blockNumber:bigint;
  logIndex:number;priceWad:bigint;valid:boolean};
export type CoverageBlock={number:bigint;timestamp:bigint};
export type CoverageTwap={available:boolean;coveredSecs:bigint;integral:bigint;twapWad:bigint};
export type CoverageCheckpoint={phase:'initial'|'gap'|'recovered';block:CoverageBlock;actual:CoverageTwap;
  sourceState:{lastSequence:bigint;lastObservedAt:bigint}};

export function replayCoverage(samples:readonly CoverageSample[],block:CoverageBlock):CoverageTwap {
  assert.ok(block.number>=0n&&block.timestamp>=300n,'invalid evaluation block');
  // A later receipt may replace a sample with the same source second. Historical
  // block filtering must happen BEFORE replacement, or later data rewrites proof.
  const known=samples.filter(s=>s.blockNumber<=block.number)
    .sort((a,b)=>a.blockNumber<b.blockNumber?-1:a.blockNumber>b.blockNumber?1:a.logIndex-b.logIndex);
  const seconds=new Map<bigint,CoverageSample>();let sequence=0n,time=0n;
  for(const s of known){
    assert.ok(s.sequence>sequence&&s.observedAt>=time,'nonmonotone accepted history');
    assert.ok(s.observedAt<=s.acceptedAt&&s.acceptedAt<=block.timestamp,'receipt later than evaluation block');
    assert.ok(s.priceWad>=0n&&s.priceWad<10n**18n&&(!s.valid||s.priceWad>0n),'invalid price');
    assert.ok(Number.isSafeInteger(s.logIndex)&&s.logIndex>=0,'invalid log index');
    sequence=s.sequence;time=s.observedAt;seconds.set(time,s);
  }
  const ordered=[...seconds.values()];let coveredSecs=0n,integral=0n;
  for(let i=0;i<ordered.length;i++){
    const s=ordered[i]!;if(!s.valid)continue;
    const next=ordered[i+1]?.observedAt??block.timestamp;
    const until=[block.timestamp,s.observedAt+30n,next].reduce((a,b)=>a<b?a:b);
    const from=s.observedAt>block.timestamp-300n?s.observedAt:block.timestamp-300n;
    const span=until>from?until-from:0n;coveredSecs+=span;integral+=span*s.priceWad;
  }
  assert.ok(coveredSecs<=300n);
  return {available:coveredSecs===300n,coveredSecs,integral,twapWad:coveredSecs===300n?integral/300n:0n};
}

export function reviewCoveragePhases(samples:readonly CoverageSample[],checks:readonly CoverageCheckpoint[]){
  assert.deepEqual(checks.map(c=>c.phase),['initial','gap','recovered'],'three ordered phases required');
  for(let i=0;i<checks.length;i++){
    const c=checks[i]!;
    if(i)assert.ok(c.block.number>checks[i-1]!.block.number&&c.block.timestamp>checks[i-1]!.block.timestamp,'phase order');
    assert.deepEqual(c.actual,replayCoverage(samples,c.block),'contract TWAP differs from segment replay');
    const last=samples.filter(s=>s.blockNumber<=c.block.number).at(-1);
    assert.ok(last,'phase has no accepted history');
    assert.equal(c.sourceState.lastSequence,last.sequence);
    assert.equal(c.sourceState.lastObservedAt,last.observedAt);
  }
  const [initial,gap,recovered]=checks as [CoverageCheckpoint,CoverageCheckpoint,CoverageCheckpoint];
  assert.ok(initial.actual.available&&recovered.actual.available,'initial and recovered windows must cover 300 seconds');
  assert.ok(!gap.actual.available&&gap.actual.coveredSecs<300n,'gap must make TWAP unavailable');
  assert.deepEqual(gap.sourceState,initial.sourceState,'publication continued during gap');
  const last=samples.filter(s=>s.blockNumber<=initial.block.number).at(-1)!;
  assert.ok(gap.block.timestamp>last.acceptedAt+30n&&gap.block.timestamp>last.observedAt+30n,'pause must exceed carry');
  const fresh=samples.find(s=>s.blockNumber>gap.block.number);
  assert.ok(fresh&&fresh.observedAt>=gap.block.timestamp,'restart must fetch a fresh source book');
  assert.ok(recovered.sourceState.lastSequence>gap.sourceState.lastSequence);
  assert.ok(recovered.block.timestamp-300n>=fresh.observedAt,'recovered window must be built after restart');
  return {verified:true,fullInitialWindow:true,pausedPublicationUnavailable:true,fullRecoveredWindow:true,
    productionApproved:false};
}
