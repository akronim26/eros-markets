import assert from 'node:assert/strict';
import {test} from 'node:test';
import {awaitSampleAck} from './sampler-coordination.mjs';
const engine='0x123';
function setup(overrides={}) {
 let t=100000;
 return {id:'7',engine,readAck:()=>null,readStatus:()=>({engine,state:'running',at:t}),signal:new AbortController().signal,
  now:()=>t,sleep:async ms=>{t+=ms},timeoutMs:1000,...overrides};
}
test('only the matching engine and sequence can advance the source timestamp',async()=>{
 for(const ack of [{id:'6',engine,sampledAt:'10'},{id:'7',engine:'0x456',sampledAt:'10'}])
  assert.deepEqual(await awaitSampleAck(setup({readAck:()=>ack})),{outcome:'coordination-timeout',acknowledged:false});
 assert.deepEqual(await awaitSampleAck(setup({readAck:()=>({id:'7',engine,sampledAt:'10',outcome:'finalized'})})),
  {outcome:'finalized',acknowledged:true,sampledAt:10n});
});
test('stopped or crashed sampler allows independent INDEX publication without inventing a sample',async()=>{
 for(const status of [{engine,state:'stopped',at:100000},{engine,state:'running',at:90000}])
  assert.deepEqual(await awaitSampleAck(setup({readStatus:()=>status})),{outcome:'sampler-unavailable',acknowledged:false});
});
test('temporary delay still accepts the final acknowledgement; mismatched heartbeat fails closed',async()=>{
 let count=0;
 const result=await awaitSampleAck(setup({readAck:()=>++count===3?{id:'7',engine,sampledAt:null,outcome:'keeper-unfunded'}:null}));
 assert.deepEqual(result,{outcome:'keeper-unfunded',acknowledged:true,sampledAt:null});
 await assert.rejects(awaitSampleAck(setup({readStatus:()=>({engine:'0x456',state:'running',at:100000})})),/IDENTITY/);
});

import { SampleCoordinator, indexFreshCutoff } from './sampler-coordination.mjs';
const hash = '0x' + 'ab'.repeat(32);
const ack = (id, time, block = time) => ({ id: String(id), engine, outcome: 'finalized', captureVersion: 1,
  sampledAt: time === null ? null : String(time), sampledBlock: block === null ? null : String(block), sampledBlockHash: time === null ? null : hash });
function coordinatorHarness({ request = null, previousAck = null, time = 0, timeoutMs = 20000 } = {}) {
  let now = time, currentAck = previousAck, currentRequest = request;
  const sleeps = [], writes = [], errors = [], results = [];
  const signal = new AbortController();
  const coordinator = new SampleCoordinator({ engine, signal: signal.signal, readRequest: () => currentRequest,
    readAck: () => currentAck, readStatus: () => ({ engine, state: 'running', at: now }),
    writeRequest: value => { currentRequest = value; writes.push(value); },
    sleep: () => new Promise(resolve => sleeps.push(resolve)), now: () => now, timeoutMs,
    onResult: value => results.push(value), onError: error => errors.push(error.message) });
  const tick = async ms => {
    now += ms;
    for (const resolve of sleeps.splice(0)) resolve();
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };
  return { coordinator, writes, errors, results, tick, setAck: value => { currentAck = value; },
    close: async () => { const close = coordinator.close(); await tick(0); await close; }, get now() { return now; } };
}

test('stalled keeper never blocks notify, never overwrites an outstanding request, and coalesces latest finality', async () => {
  const h = coordinatorHarness({ timeoutMs: 1000 });
  h.coordinator.notify({ sequence: 1n, observedAt: 10n }); await h.tick(0);
  for (let sequence = 2n; sequence <= 4n; sequence++) assert.equal(h.coordinator.notify({ sequence, observedAt: sequence + 20n }), undefined);
  await h.tick(1500); await h.tick(250); // timeout retains ownership
  assert.deepEqual(h.writes.map(r => r.id), ['1']);
  h.setAck(ack(1, 12)); await h.tick(250); await h.tick(250);
  assert.deepEqual(h.writes.map(r => r.id), ['1', '4']);
  assert.deepEqual(h.errors, []); await h.close();
});

test('wrong identity cannot release a request; a late exact acknowledgement can', async () => {
  const h = coordinatorHarness();
  h.coordinator.notify({ sequence: 1n, observedAt: 10n }); await h.tick(0);
  h.coordinator.notify({ sequence: 2n, observedAt: 20n });
  for (const wrong of [ack(2, 12), { ...ack(1, 12), engine: '0x999' }]) {
    h.setAck(wrong); await h.tick(500); assert.equal(h.writes.length, 1);
  }
  h.setAck(ack(1, 12)); await h.tick(250); await h.tick(250);
  assert.equal(h.writes[1].id, '2'); await h.close();
});

test('only a finalized source strictly after the actual capture requests its seal', async () => {
  const h = coordinatorHarness({ previousAck: ack(1, 100) });
  h.coordinator.notify({ sequence: 2n, observedAt: 99n }); await h.tick(250);
  h.coordinator.notify({ sequence: 3n, observedAt: 100n }); await h.tick(250);
  assert.equal(h.writes.length, 0);
  h.coordinator.notify({ sequence: 4n, observedAt: 101n }); await h.tick(250);
  assert.deepEqual(h.writes.map(r => r.id), ['4']); await h.close();
});

test('restart resumes the exact unacknowledged request; shutdown cannot launch its coalesced successor', async () => {
  const h = coordinatorHarness({ request: { id: '7', engine }, previousAck: ack(6, 100) });
  h.coordinator.notify({ sequence: 8n, observedAt: 110n }); await h.tick(250);
  assert.equal(h.writes.length, 0);
  await h.close(); h.setAck(ack(7, 105)); await h.tick(250);
  h.coordinator.notify({ sequence: 9n, observedAt: 120n });
  assert.equal(h.writes.length, 0);
});

test('malformed capture metadata disables sampling without throwing from future INDEX notifications', async () => {
  const h = coordinatorHarness();
  h.coordinator.notify({ sequence: 1n, observedAt: 10n }); await h.tick(0);
  h.setAck({ ...ack(1, 12), sampledBlockHash: null }); await h.tick(250);
  assert.deepEqual(h.errors, ['INVALID_SAMPLER_CAPTURE']);
  assert.doesNotThrow(() => h.coordinator.notify({ sequence: 2n, observedAt: 20n })); await h.close();
});

test('5s source updates, 7s publication and 5s sampling can seal successive captures', async () => {
  const h = coordinatorHarness({ time: 7000 });
  const trace = [];
  h.coordinator.notify({ sequence: 1n, observedAt: 0n }); await h.tick(0);
  h.setAck(ack(1, 12)); await h.tick(5000);
  assert.equal(h.coordinator.getMinimumObservedAt(14000), 12n); // observation10 waits
  assert.ok(15n > h.coordinator.getMinimumObservedAt(15000));
  await h.tick(10000); // publication started at15, canonical finality at22
  h.coordinator.notify({ sequence: 2n, observedAt: 15n }); await h.tick(0);
  h.setAck(ack(2, 27)); await h.tick(5000); // source15 seals capture12, age15
  trace.push({ captured: 12, sealed: 27, finalizedIndex: 15 });
  assert.equal(h.coordinator.getMinimumObservedAt(28000), 27n); // observation25 waits
  assert.ok(30n > h.coordinator.getMinimumObservedAt(30000));
  await h.tick(10000); // publication started at30, canonical finality at37
  h.coordinator.notify({ sequence: 3n, observedAt: 30n }); await h.tick(0);
  h.setAck(ack(3, 42)); await h.tick(5000);
  trace.push({ captured: 27, sealed: 42, finalizedIndex: 30 });
  assert.ok(trace.every(t => t.finalizedIndex > t.captured && t.sealed - t.captured < 30));
  assert.deepEqual(h.writes.map(r => r.id), ['1', '2', '3']); await h.close();
});

test('known Senate capture does not admit an invalidating prefix at the older INDEX deadline', async () => {
  // 1000=22:25:55; capture1013=22:26:08; source1010=22:26:05.
  const h = coordinatorHarness({ time: 1007000 });
  h.coordinator.notify({ sequence: 64n, observedAt: 1000n }); await h.tick(0);
  h.setAck(ack(64, 1013)); await h.tick(6000);
  assert.equal(h.coordinator.getMinimumObservedAt(1017000), 1013n);
  const oldDeadline = 1022000; //22:26:17; old source plus22 seconds
  assert.equal(h.coordinator.getMinimumObservedAt(oldDeadline), 1013n);
  assert.ok(1010n <= h.coordinator.getMinimumObservedAt(oldDeadline));
  assert.ok(1028n > h.coordinator.getMinimumObservedAt(1028000), 'genuine source26:23 can seal capture26:08');
  const deadline = 1035000; // actual capture plus22 seconds; never an unbounded wait
  assert.equal(h.coordinator.getMinimumObservedAt(deadline), indexFreshCutoff(deadline));
  // Inclusion can occur after old INDEX carry expires. Only authentic source
  // timestamps determine whether its historical intervals remain continuous.
  assert.ok(1028n - 1000n < 30n);
  await h.close();
});

test('unknown or permanently hung capture also releases soft preference at its delivery deadline', async () => {
  const h = coordinatorHarness({ time: 1007000 });
  h.coordinator.notify({ sequence: 1n, observedAt: 1000n }); await h.tick(0);
  assert.equal(h.coordinator.getMinimumObservedAt(1010000), 1010n);
  assert.equal(h.coordinator.getMinimumObservedAt(1022000), 1004n);
  await h.close();
});

test('archived Republic arrivals seal successive captures with measured 4–6s inclusion latency', async () => {
  // Source journal: 22:43:47 accepted; capture22:43:58; intermediate43:53.494
  // received43:53.986; new44:07.491 received44:08.038; new44:27.869 received44:28.068.
  // Offset zero is22:43:47. Keep genuine source timestamps, including millisecond receipt delay.
  for (const inclusionSecs of [4, 5, 6]) {
    const h = coordinatorHarness({ previousAck: ack(109, 11), time: 14000 });
    h.coordinator.notify({ sequence: 109n, observedAt: 0n });
    assert.ok(6n <= h.coordinator.getMinimumObservedAt(18000), 'intermediate source cannot invalidate capture at the former12s-reserve deadline');
    assert.ok(6n <= h.coordinator.getMinimumObservedAt(18000, indexFreshCutoff(18000), 12n), 'capture time also protects the prefix with a larger delivery reserve');
    assert.ok(6n > indexFreshCutoff(18000), 'the former INDEX-based12s-reserve deadline admitted the invalidating prefix');
    const arrivals = [{ observed: 20n, received: 21038 }, { observed: 40n, received: 41068 }];
    let previousCapture = 11, previousSource = 0;
    for (const [index, source] of arrivals.entries()) {
      assert.ok(source.observed > h.coordinator.getMinimumObservedAt(source.received));
      const included = source.received / 1000 + inclusionSecs;
      assert.ok(included < previousSource + 30, 'INDEX inclusion precedes prior carry expiry');
      const finalizedMs = source.received + inclusionSecs * 1000 + 2000;
      await h.tick(finalizedMs - h.now);
      const sequence = BigInt(110 + index);
      h.coordinator.notify({ sequence, observedAt: source.observed }); await h.tick(0);
      const captured = Math.floor(finalizedMs / 1000) + 3;
      assert.ok(source.observed > BigInt(previousCapture), 'authenticated source seals the actual prior capture');
      assert.ok(captured - previousCapture < 30, 'capture is promoted within its original lifetime');
      h.setAck(ack(sequence, captured)); await h.tick(5000);
      previousCapture = captured; previousSource = Number(source.observed);
    }
    assert.deepEqual(h.writes.map(request => request.id), ['110', '111']);
    await h.close();
  }
});

test('legacy receipt timestamps never become capture evidence, and invalid INDEX does not defer recovery', async () => {
  const h = coordinatorHarness({ previousAck: { id: '1', engine, sampledAt: '999999', outcome: 'finalized' } });
  h.coordinator.notify({ sequence: 2n, observedAt: 10n }); await h.tick(0);
  assert.deepEqual(h.writes.map(r => r.id), ['2'], 'first actual capture is allowed after legacy acknowledgement');
  h.coordinator.notify({ sequence: 3n, observedAt: 11n, depthValid: false });
  assert.equal(h.coordinator.getMinimumObservedAt(12000), indexFreshCutoff(12000));
  await h.close();
});

for (const trace of [
  { market: 'BTC', sequence: 44n, source: 1791498481n, capture: 1791498495n,
    oldPrefix: 1791498487n, oldPublicationMs: 1791498503000, firstSealableSource: 1791498505n,
    firstReceivedMs: 1791498505786, laterAcceptedSource: 1791498508n, laterAcceptedAt: 1791498514n, sampleAt: 1791498519n },
  { market: 'ETH', sequence: 40n, source: 1791498392n, capture: 1791498411n,
    oldPrefix: 1791498407n, oldPublicationMs: 1791498414000, firstSealableSource: 1791498420n,
    firstReceivedMs: 1791498421584, laterAcceptedSource: 1791498420n, laterAcceptedAt: 1791498426n, sampleAt: 1791498432n },
]) test(`${trace.market} canonical delayed REST trace preserves the capture without retimestamping`, async () => {
  // From the public-testnet capture/observation receipts and archived REST
  // arrivals in the October8 22:26–22:28 continuity audit. The old fallback
  // really published oldPrefix; these assertions replay its selection decision.
  const h = coordinatorHarness({ previousAck: ack(trace.sequence, trace.capture), time: Number(trace.capture) * 1000 });
  h.coordinator.notify({ sequence: trace.sequence, observedAt: trace.source });
  assert.ok(trace.oldPrefix > indexFreshCutoff(trace.oldPublicationMs), 'old fallback admitted the authentic but retroactive prefix');
  assert.equal(h.coordinator.getMinimumObservedAt(trace.oldPublicationMs), trace.capture);
  assert.ok(trace.oldPrefix <= h.coordinator.getMinimumObservedAt(trace.oldPublicationMs), 'never rewrite the capture-time INDEX checkpoint');
  assert.ok(trace.firstSealableSource > h.coordinator.getMinimumObservedAt(trace.firstReceivedMs), 'admit the first genuine prefix after the capture');
  assert.ok(trace.firstSealableSource - trace.source < 30n, 'the first source candidate can preserve historical INDEX coverage');
  assert.ok(trace.laterAcceptedSource > trace.capture && trace.laterAcceptedSource - trace.source < 30n, 'the actually accepted later prefix also covers the original source interval');
  assert.ok(trace.laterAcceptedAt >= trace.source + 30n, 'this trace does not promise continuously live INDEX before delivery');
  // The real samples recorded invalid points after the old prefix had already
  // rewritten history. Their times show a counterfactual sealing opportunity;
  // this replay does not claim a successful on-chain seal under the new policy.
  assert.ok(trace.sampleAt - trace.capture < 30n, 'sample opportunity remains inside the original capture lifetime');
  const deadline = Number(trace.capture + 22n) * 1000;
  assert.equal(h.coordinator.getMinimumObservedAt(deadline), indexFreshCutoff(deadline), 'known-capture preference still expires');
  assert.equal(h.coordinator.getMinimumObservedAt(deadline + 60000), indexFreshCutoff(deadline + 60000), 'no keeper can extend this fixed deadline');
  await h.close();
});

test('a newer outstanding capture retains its own independent INDEX deadline after restart', async () => {
  const h = coordinatorHarness({ previousAck: ack(1, 100), request: { id: '2', engine, observedAt: '105' }, time: 110000 });
  h.coordinator.notify({ sequence: 2n, observedAt: 105n });
  assert.equal(h.coordinator.getMinimumObservedAt(122000), 122n, 'old acknowledged capture cannot release an unknown newer capture early');
  assert.equal(h.coordinator.getMinimumObservedAt(127000), indexFreshCutoff(127000), 'hung new request cannot freeze INDEX indefinitely');
  await h.close();
});

test('a future-dated restored acknowledgement cannot extend the accepted INDEX deadline', async () => {
  const h = coordinatorHarness({ previousAck: ack(1, 999999), time: 1007000 });
  h.coordinator.notify({ sequence: 1n, observedAt: 1000n });
  assert.equal(h.coordinator.getMinimumObservedAt(1022000), indexFreshCutoff(1022000));
  assert.equal(h.coordinator.getMinimumObservedAt(1100000), indexFreshCutoff(1100000));
  await h.close();
});

test('finality notification persists its request before immediate budget shutdown and restores exact ownership', async () => {
  const h = coordinatorHarness();
  h.coordinator.notify({ sequence: 10n, observedAt: 100n });
  assert.deepEqual(h.writes, [{ id: '10', engine, observedAt: '100' }], 'no background tick is required for durability');
  const request = h.writes[0]; await h.close();
  const restarted = coordinatorHarness({ request });
  restarted.coordinator.notify({ sequence: 9n, observedAt: 99n });
  restarted.coordinator.notify({ sequence: 10n, observedAt: 100n });
  restarted.coordinator.notify({ sequence: 11n, observedAt: 101n });
  assert.deepEqual(restarted.writes, [], 'older replay and newer finality cannot replace the outstanding request');
  restarted.setAck(ack(10, 100)); await restarted.tick(250); await restarted.tick(250);
  assert.deepEqual(restarted.writes.map(value => value.id), ['11']); await restarted.close();
});
