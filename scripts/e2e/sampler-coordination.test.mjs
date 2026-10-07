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

test('Senate delayed-source trace yields to INDEX before old observation expires', async () => {
  // 1000=22:25:55; capture1013=22:26:08; source1010=22:26:05.
  const h = coordinatorHarness({ time: 1007000 });
  h.coordinator.notify({ sequence: 64n, observedAt: 1000n }); await h.tick(0);
  h.setAck(ack(64, 1013)); await h.tick(6000);
  assert.equal(h.coordinator.getMinimumObservedAt(1017000), 1013n);
  const deadline = 1022000; //22:26:17; reserve8 seconds
  assert.equal(h.coordinator.getMinimumObservedAt(deadline), indexFreshCutoff(deadline));
  assert.ok(1010n > h.coordinator.getMinimumObservedAt(deadline));
  assert.ok(1022 + 7 < 1000 + 30, 'source26:05 can finalize26:24 before expiry26:25');
  // No need to wait for source22:26:28; packet timestamps are never changed.
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
    assert.ok(6n > h.coordinator.getMinimumObservedAt(18000, indexFreshCutoff(18000), 12n), 'old reserve reproduced the live invalidating publication');
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
