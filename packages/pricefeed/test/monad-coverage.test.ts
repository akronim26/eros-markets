import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayCoverage, reviewCoveragePhases, type CoverageSample, type CoverageCheckpoint } from '../scripts/monad-coverage.js';

const price=630000000000000000n;
const sample=(sequence:number,time:number,block=sequence,valid=true):CoverageSample=>({sequence:BigInt(sequence),
  observedAt:BigInt(time),acceptedAt:BigInt(time+2),blockNumber:BigInt(block),logIndex:0,priceWad:valid?price:0n,valid});
const initial=Array.from({length:16},(_,i)=>sample(i+1,1000+20*i));
const recovery=Array.from({length:16},(_,i)=>sample(i+17,1400+20*i));
const checkpoint=(phase:CoverageCheckpoint['phase'],number:number,timestamp:number,samples:CoverageSample[]):CoverageCheckpoint=>{
  const block={number:BigInt(number),timestamp:BigInt(timestamp)},last=samples.filter(s=>s.blockNumber<=block.number).at(-1)!;
  return {phase,block,actual:replayCoverage(samples,block),sourceState:{lastSequence:last.sequence,lastObservedAt:last.observedAt}};
};
test('coverage verifies hand-derived full, expired carry and full post-restart windows',()=>{
  const samples=[...initial,...recovery];
  // 300 seconds at 0.63, then 262 valid seconds after 70 seconds without publishing.
  assert.deepEqual(replayCoverage(samples,{number:16n,timestamp:1302n}),
    {available:true,coveredSecs:300n,integral:189000000000000000000n,twapWad:price});
  assert.deepEqual(replayCoverage(samples,{number:16n,timestamp:1368n}),
    {available:false,coveredSecs:262n,integral:165060000000000000000n,twapWad:0n});
  const spaced=samples.map(s=>({...s,blockNumber:s.blockNumber*10n}));
  const phases=[checkpoint('initial',160,1302,spaced),checkpoint('gap',169,1368,spaced),checkpoint('recovered',320,1702,spaced)];
  assert.equal(reviewCoveragePhases(spaced,phases).verified,true);
});
test('later same-second invalid replacement cannot rewrite an earlier block proof',()=>{
  const history=[...initial,sample(17,1300,17,false)];
  assert.equal(replayCoverage(history,{number:16n,timestamp:1302n}).coveredSecs,300n);
  assert.equal(replayCoverage(history,{number:17n,timestamp:1302n}).coveredSecs,298n);
  assert.equal(replayCoverage(history,{number:17n,timestamp:1302n}).available,false);
});
test('thin book terminates carry and a missing source cannot create synthetic coverage',()=>{
  const history=[sample(1,1000),sample(2,1020,2,false),sample(3,1060)];
  assert.deepEqual(replayCoverage(history,{number:3n,timestamp:1092n}),
    {available:false,coveredSecs:50n,integral:31500000000000000000n,twapWad:0n});
  assert.equal(replayCoverage([],{number:0n,timestamp:1300n}).coveredSecs,0n);
});
test('replay rejects backward or duplicate accepted sequences, future receipts and malformed evaluation blocks',()=>{
  for(const history of [[sample(1,1000),sample(1,1020,2)], [sample(1,1020),sample(2,1000)],
    [sample(1,1400)]])assert.throws(()=>replayCoverage(history,{number:10n,timestamp:1300n}));
  assert.throws(()=>replayCoverage([],{number:0n,timestamp:299n}));
});
test('phase review rejects continued publication, changed TWAP, stale restart and recovery before window rolls forward',()=>{
  const samples=[...initial,...recovery].map(s=>({...s,blockNumber:s.blockNumber*10n}));
  const phases=[checkpoint('initial',160,1302,samples),checkpoint('gap',169,1368,samples),checkpoint('recovered',320,1702,samples)];
  const bad=structuredClone(phases);bad[0]!.actual.integral++;
  assert.throws(()=>reviewCoveragePhases(samples,bad));
  assert.throws(()=>reviewCoveragePhases(samples,[phases[0]!,phases[1]!,checkpoint('recovered',310,1682,samples)]));
  assert.throws(()=>reviewCoveragePhases(samples,[phases[1]!,phases[0]!,phases[2]!]));
  const extra=[...samples,sample(33,1310,165)].sort((a,b)=>Number(a.blockNumber-b.blockNumber));
  assert.throws(()=>reviewCoveragePhases(extra,phases));
  const stale=samples.map(s=>s.sequence>=17n?{...s,observedAt:s.observedAt-40n}:s);
  assert.throws(()=>reviewCoveragePhases(stale,phases));
});
