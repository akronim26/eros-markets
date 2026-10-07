import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizedOwnerReceipt, canonicalFinalizedReceipt, FinalizedOwnerRevert } from '../src/lib/finality.ts';
import { leverageLots } from '../src/lib/leverage.ts';
const hash = `0x${'1'.repeat(64)}`, blockHash = `0x${'2'.repeat(64)}`;
const owner = `0x${'3'.repeat(40)}`, to = `0x${'4'.repeat(40)}`, data = '0xabcd';
function fixture(change = {}) {
 const receipt = { transactionHash:hash,blockHash,blockNumber:12n,status:'success',logs:[] };
 const transaction = { hash, blockNumber:12n,from:owner,to,input:data,value:0n,blockHash };
 let polls = 0;
 return { receipt, transaction, client: {
  waitForTransactionReceipt:async()=>({...receipt,...change.receipt}),
  getTransactionReceipt:async()=>({...receipt,...change.receipt,...change.finalReceipt}),
  getBlock:async(args)=> args.blockTag ? {number:++polls < 2 ? 11n : 12n, hash:blockHash} : {number:12n, hash:change.canonicalHash ?? blockHash},
  getTransaction:async()=>({...transaction,...change.transaction}),
 }, polls:()=>polls };
}
test('dependent owner calls wait for finality, then verify canonical block and exact transaction', async()=>{
 const f=fixture();assert.deepEqual(await finalizedOwnerReceipt(f.client,hash,{owner,to,data},{pollMs:1}), f.receipt);
 assert.equal(f.polls(),2);
});
test('replacements, reverts, reorgs and changes in sender, target, value or calldata stop the flow',async()=>{
 for(const change of [{receipt:{transactionHash:blockHash}},{receipt:{status:'reverted'}},{canonicalHash:hash},
 {finalReceipt:{blockHash:hash}},{finalReceipt:{blockNumber:13n}},{transaction:{hash:blockHash}},{transaction:{blockNumber:13n}},{transaction:{from:to}},{transaction:{to:owner}},{transaction:{input:'0xabce'}},{transaction:{value:1n}},{transaction:{blockHash:hash}}]) {
  await assert.rejects(finalizedOwnerReceipt(fixture(change).client,hash,{owner,to,data},{pollMs:1}));
 }
});
test('pending finality stops before dependent steps rather than treating inclusion as final',async()=>{
 const f=fixture();f.client.getBlock=async()=>({number:11n,hash:blockHash});
 await assert.rejects(finalizedOwnerReceipt(f.client,hash,{owner,to,data},{timeoutMs:0,pollMs:0}), /finality is still pending/);
});
test('integer leverage sizes exact long and short claim lots without float rounding',()=>{
 for(let x=1;x<=5;x++) {
  assert.equal(leverageLots(100n*10n**24n,250,true,x),400000n*BigInt(x));
  assert.equal(leverageLots(100n*10n**24n,750,false,x),400000n*BigInt(x));
 }
 for(const x of [0,1.5,6,NaN])assert.throws(()=>leverageLots(10n**24n,500,true,x));
 assert.throws(()=>leverageLots(0n,500,true,1));
});

test('5x sizing reserves adverse spread and fees for either direction',()=>{
 const equity=88n*10n**23n, mark=645n*10n**15n;
 for (const [buy,tick] of [[true,655],[false,635]]) {
  const entry=BigInt(tick)*10n**18n, m=mark*1000n, fee=10n**16n;
  const loss=(buy?entry-m:m-entry)+fee, notional=buy?m:10n**21n-m;
  const lots=leverageLots(equity,tick,buy,5,mark,fee);
  assert.ok(lots*notional <= 5n*(equity-lots*loss));
  assert.ok((lots+1n)*notional > 5n*(equity-(lots+1n)*loss));
  assert.ok(lots<leverageLots(equity,tick,buy,5));
 }
 assert.equal(leverageLots(equity,655,true,5,mark),63309n);
 for(const mark of [0n,10n**18n])assert.throws(()=>leverageLots(equity,655,true,5,mark));
});

test('favourable unfilled limits do not create imaginary sizing equity',()=>{
 const equity=10n**24n,mark=500n*10n**15n;
 assert.equal(leverageLots(equity,400,true,5,mark),10000n);
 assert.equal(leverageLots(equity,600,false,5,mark),10000n);
});

test('finalized receipt readers preserve a finalized revert as a failed result',async()=>{
 const receipt=await canonicalFinalizedReceipt(fixture({receipt:{status:'reverted'}}).client,hash,{pollMs:1});
 assert.equal(receipt.status,'reverted');
});

test('only an exact canonical owner revert is a terminal result that may clear a saved request', async () => {
 await assert.rejects(finalizedOwnerReceipt(fixture({receipt:{status:'reverted'}}).client,hash,{owner,to,data},{pollMs:1}), FinalizedOwnerRevert);
 for (const transaction of [{from:to},{to:owner},{input:'0xdead'},{value:1n},{blockHash:hash}]) {
  await assert.rejects(finalizedOwnerReceipt(fixture({receipt:{status:'reverted'},transaction}).client,hash,{owner,to,data},{pollMs:1}), error => !(error instanceof FinalizedOwnerRevert) && /identity/.test(error.message));
 }
});
