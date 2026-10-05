import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectionDecision, validateRule } from '../src/lib/protection.ts';
import { validateIntent } from '../src/lib/delegated-intent.ts';
import { closeIntent, expiryBlock } from '../src/lib/trade-intent.ts';
import { canDispute, validEvidence } from '../src/lib/oracle-actions.ts';
const engine='0x1111111111111111111111111111111111111111';
const rule={kind:'stop_loss',triggerTick:400,limitTick:380,maxLots:'1000',long:true,expires:2000};
const snapshot={now:1000n,markAvailable:true,markWad:390000000000000000n,lots:1000n,status:1,e0:1n,e1:1n,secsToT:80000n,monitorRestricted:false,stage:0,halted:false,leveraged:false,claimable:0n};
test('price protection respects direction, mark availability, flat positions, expiry and halt',()=>{
 assert.equal(protectionDecision(rule,snapshot),'reduce');
 assert.equal(protectionDecision(rule,{...snapshot,markAvailable:false}),'wait');
 assert.equal(protectionDecision(rule,{...snapshot,lots:0n}),'done');
 assert.equal(protectionDecision(rule,{...snapshot,lots:-1000n}),'done');
 assert.equal(protectionDecision(rule,{...snapshot,now:2000n}),'expired');
 assert.equal(protectionDecision(rule,{...snapshot,halted:true}),'done');
 assert.equal(protectionDecision({...rule,long:false},{...snapshot,lots:-1000n}),'wait');
 assert.equal(protectionDecision({...rule,kind:'take_profit'},snapshot),'wait');
});
test('guards activate only with the correct capability and threshold; claims need actual entitlement',()=>{
 assert.equal(protectionDecision({...rule,kind:'risk_guard'},{...snapshot,status:3}),'wait');
 assert.equal(protectionDecision({...rule,kind:'risk_guard'},{...snapshot,status:3,leveraged:true}),'reduce');
 assert.equal(protectionDecision({...rule,kind:'backing_guard'},{...snapshot,leveraged:true,secsToT:44000n,e0:-1n}),'reduce');
 assert.equal(protectionDecision({...rule,kind:'auto_cancel'},{...snapshot,secsToT:4500n}),'cancel');
 assert.equal(protectionDecision({...rule,kind:'claim_delivery'},{...snapshot,halted:true,claimable:1n}),'claim');
 assert.equal(protectionDecision({...rule,kind:'claim_delivery'},{...snapshot,halted:true}),'wait');
});
test('rules reject invalid sizes, prices and unbounded lifetimes',()=>{
 assert.deepEqual(validateRule(rule,1000),rule);
 for(const patch of [{expires:1000},{expires:99999999},{maxLots:'-1'},{maxLots:'1.2'},{limitTick:1000},{triggerTick:0},{kind:'transfer'}]) assert.throws(()=>validateRule({...rule,...patch},1000));
});
const intent={wallet:engine,engine,previewBlock:'1234',clientNonce:'0123456789abcdef',action:'placeOrder',place:{kind:1,isBuy:false,reduceOnly:true,tick:380,size:'1000',maxFills:8,expiryBlock:0}};
test('delegated request refuses transfers, arbitrary calldata, unknown engines, excessive integers and non-reductions',()=>{
 assert.deepEqual(validateIntent(intent,[engine],true),intent);
 for(const patch of [{action:'withdraw'},{action:'batch'},{to:engine},{data:'0xa9059cbb'},{value:'1'},{engine:'0x2222222222222222222222222222222222222222'}]) assert.throws(()=>validateIntent({...intent,...patch},[engine]));
 for(const patch of [{reduceOnly:false},{kind:0},{size:'18446744073709551616'},{tick:1000},{isBuy:1},{maxFills:256}]) assert.throws(()=>validateIntent({...intent,place:{...intent.place,...patch}},[engine],true));
});
test('close prefill uses the opposite side and exact lots; expiry never rounds',()=>{
 assert.deepEqual({...closeIntent(12345n,400,600,5000),nonce:0},{nonce:0,side:'sell',size:'6.172',price:'0.400'});
 assert.equal(closeIntent(-1000n,400,600).side,'buy');
 assert.equal(closeIntent(-1000n,0,0).price,'');
 assert.equal(expiryBlock('',100n),0);
 assert.equal(expiryBlock('101',100n),101);
 for(const v of ['100','99','4294967296','1.2','1e3']) assert.throws(()=>expiryBlock(v,100n));
});
test('disputes close at exact expiry; evidence respects the contract byte limit',()=>{
 const a={exists:true,disputed:false,settled:false,expiresAt:100n};
 assert.equal(canDispute(a,99n),true);assert.equal(canDispute(a,100n),false);
 assert.equal(canDispute({...a,disputed:true},99n),false);
 assert.equal(validEvidence('https://example.com/evidence','0x'+'ab'.repeat(32)),true);
 assert.equal(validEvidence('https://'+'x'.repeat(249),'0x'+'ab'.repeat(32)),false);
 assert.equal(validEvidence('javascript:alert(1)','0x'+'ab'.repeat(32)),false);
 assert.equal(validEvidence('ipfs://evidence','0x'+'0'.repeat(64)),false);
});
