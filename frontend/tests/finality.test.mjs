import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizedOwnerReceipt, canonicalFinalizedReceipt } from '../src/lib/finality.ts';
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

test('finalized receipt readers preserve a finalized revert as a failed result',async()=>{
 const receipt=await canonicalFinalizedReceipt(fixture({receipt:{status:'reverted'}}).client,hash,{pollMs:1});
 assert.equal(receipt.status,'reverted');
});
