import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex } from 'viem';
import { ACCEPTED_ABI, confirmationState, validateReceipt, type DeliveryReceipt, type ReceiptLog } from '../src/receipts.js';
import { observationDigest } from '../src/wire.js';
import type { PreparedPacket } from '../src/packet-store.js';

const h=(byte:string)=>('0x'+byte.repeat(32)) as Hex;
const packet:PreparedPacket={domain:{chainId:31337n,engine:'0x1111111111111111111111111111111111111111',marketId:h('01'),sourceId:h('02'),rulesHash:h('03'),signer:'0x2222222222222222222222222222222222222222'},
  observation:{marketId:h('01'),sourceId:h('02'),sourceRulesHash:h('03'),sequence:1n,observedAt:1000n,publishedAt:1001n,
    priceWad:600000000000000000n,impactBidWad:590000000000000000n,impactAskWad:610000000000000000n,bidDepthLots:5000n,askDepthLots:5000n},sourceMs:1000000n,evidenceHash:h('04')};
const block={number:10n,hash:h('bb'),timestamp:1002n},tx=h('aa'),rule={depthNLots:5000n,maxSpreadWad:50000000000000000n};
function receipt(p=packet,valid=true,price=600000000000000000n):DeliveryReceipt {
  const o=p.observation;
  const log:ReceiptLog={address:p.domain.engine,transactionHash:tx,blockNumber:block.number,blockHash:block.hash,logIndex:0,removed:false,
    topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
    data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
      [o.sequence,o.observedAt,o.publishedAt,block.timestamp,price,valid,observationDigest(o,p.domain.chainId,p.domain.engine)])};
  return {status:'success',transactionHash:tx,blockNumber:block.number,blockHash:block.hash,logs:[log]};
}
test('receipt requires exact event, source/digest and block; success alone is insufficient',()=>{
  const r=receipt(),accepted=validateReceipt(packet,tx,r,block,rule);
  assert.equal(accepted.state,'MINED');assert.equal(accepted.depthValid,true);
  assert.throws(()=>validateReceipt(packet,tx,{...r,logs:[]},block,rule),/EXACTLY_ONE/);
  assert.throws(()=>validateReceipt(packet,tx,{...r,status:'reverted'},block,rule),/REVERTED/);
  assert.throws(()=>validateReceipt(packet,h('ff'),r,block,rule),/IDENTITY/);
  assert.throws(()=>validateReceipt(packet,tx,{...r,logs:[r.logs[0]!,r.logs[0]!]},block,rule),/EXACTLY_ONE/);
  for(const change of [{removed:true},{blockHash:h('cc')},{transactionHash:h('dd')},{logIndex:-1}])
    assert.throws(()=>validateReceipt(packet,tx,{...r,logs:[{...r.logs[0]!,...change}]},block,rule),/LOG_MISMATCH/);
  const other={...packet,observation:{...packet.observation,observedAt:999n}};
  assert.throws(()=>validateReceipt(packet,tx,receipt(other),block,rule),/LOG_MISMATCH/);
  assert.throws(()=>validateReceipt(packet,tx,receipt(packet,true,1n),block,rule),/LOG_MISMATCH/);
});
test('invalid-depth success is retained with zero emitted midpoint, distinct from valid index readiness',()=>{
  const invalid={...packet,observation:{...packet.observation,bidDepthLots:0n,priceWad:0n}};
  const accepted=validateReceipt(invalid,tx,receipt(invalid,false,0n),block,rule);
  assert.equal(accepted.depthValid,false);assert.equal(accepted.priceWad,0n);
  assert.throws(()=>validateReceipt(invalid,tx,receipt(invalid,true,0n),block,rule),/LOG_MISMATCH/);
});
test('finality policy is explicit; missing canonical data stays mined and differing block is orphaned',()=>{
  const accepted=validateReceipt(packet,tx,receipt(),block,rule);
  assert.equal(confirmationState(accepted,block.hash,10n,2n),'MINED');
  assert.equal(confirmationState(accepted,block.hash,11n,2n),'FINALIZED');
  assert.equal(confirmationState(accepted,h('cc'),11n,2n),'ORPHANED');
  assert.equal(confirmationState(accepted,null,999n,2n),'MINED');
  assert.equal(confirmationState(accepted,block.hash,9n,2n),'MINED');
  assert.throws(()=>confirmationState(accepted,block.hash,11n,0n),/POLICY/);
});
