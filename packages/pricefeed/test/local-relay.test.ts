import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy } from '../src/local-relay.js';
import { PacketStore } from '../src/packet-store.js';
import { signPrepared } from '../src/publication.js';
import { ACCEPTED_ABI, type DeliveryReceipt } from '../src/receipts.js';
import { candidate, config, signer, h } from './publication-fixture.js';

const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex); // Public local fixture only.
const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
  headroomMs:1000n,confirmations:2n,timeoutMs:1000,maxAttempts:3,leaseMs:100000n};
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-relay-')),packets=new PacketStore(join(dir,'packets.sqlite'));
  let now=1000100n,receipt:DeliveryReceipt|null=null,blockHash=h('aa') as Hex,head=10n;
  const domain=candidate(1n).domain,fence=packets.acquire(domain,'owner',now,100000n);
  packets.reconcile(domain,'owner',fence,now,{lastSequence:0n,lastObservedAt:0n});
  packets.allocate(domain,'owner',fence,now,s=>candidate(s));
  const signed=await signPrepared(packets,domain,'owner',fence,1n,signer,()=>now,1000n);
  let failSend=false,prepareCalls=0;const sent:Hex[]=[];
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:sender.address,pendingNonce:async()=>0n,
    identity:async()=>({chainId:31337n,engineCodeHash:config.destination!.engineCodeHash,abiHash:config.destination!.abiHash,
      signer:domain.signer,rulesHash:domain.rulesHash,lastSequence:0n,lastObservedAt:0n,
      listing:{...config.destination,indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
        depthNLots:config.pricing.depthNLots,maxSpreadWad:config.pricing.maxSpreadWad}}),
    simulate:async()=>{},prepare:async(req)=>{prepareCalls++;return sender.signTransaction({type:'eip1559',chainId:31337,
      to:req.to as Hex,data:req.data,nonce:Number(req.nonce),gas:req.gas,maxFeePerGas:req.maxFeePerGas,maxPriorityFeePerGas:req.maxPriorityFeePerGas,value:0n});},
    broadcast:async(raw)=>{sent.push(raw);if(failSend)throw new Error('connection lost after sending');return keccak256(raw);},
    receipt:async()=>receipt,block:async(n)=>({number:n,hash:blockHash,timestamp:1001n}),head:async()=>head};
  const relay=new LocalRelay(join(dir,'relay.sqlite'),packets,transport,policy,()=>now);await relay.start();
  return {dir,packets,relay,domain,fence,signed,transport,sent,prepareCalls:()=>prepareCalls,
    setFail:(v:boolean)=>{failSend=v;},setNow:(v:bigint)=>{now=v;},setBlock:(hash:Hex,n:bigint)=>{blockHash=hash;head=n;},
    accepted:(tx:Hex)=>{
      const o=signed.packet.observation;
      receipt={status:'success',transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logs:[{
        address:domain.engine,transactionHash:tx,blockNumber:10n,blockHash:h('aa') as Hex,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,1001n,o.priceWad,true,signed.digest])}]};
    },clearReceipt:()=>{receipt=null;},close:()=>{relay.close();packets.close();rmSync(dir,{recursive:true,force:true});}};
}
test('unknown send retries original raw transaction/nonce; exact receipt is mined then finalized and orphaned',async()=>{
  const s=await setup();
  try{
    s.setFail(true);const unknown=await s.relay.deliver(config,'owner',s.fence,1n);
    assert.equal(unknown.state,'UNKNOWN');assert.equal(unknown.nonce,0n);assert.equal(s.prepareCalls(),1);
    s.setFail(false);const retry=await s.relay.deliver(config,'owner',s.fence,1n);
    assert.equal(retry.txHash,unknown.txHash);assert.equal(s.sent[0],s.sent[1]);assert.equal(s.prepareCalls(),1);
    s.accepted(retry.txHash!);assert.equal((await s.relay.reconcile(config,1n)).state,'MINED');
    s.setBlock(h('aa') as Hex,11n);assert.equal((await s.relay.reconcile(config,1n)).state,'FINALIZED');
    s.clearReceipt();s.setBlock(h('bb') as Hex,11n);
    const orphan=await s.relay.reconcile(config,1n);assert.equal(orphan.state,'ORPHANED');assert.equal(orphan.accepted,null);
    assert.equal(s.packets.get(s.domain,1n)!.packet.observation.sequence,1n);
  }finally{s.close();}
});
test('slow lifecycle guard cannot consume source headroom unnoticed before nonce reservation or broadcast',async()=>{
  for(const delayedCheck of [1,2]){
    const s=await setup();let checks=0;try{
      await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n,async()=>{
        if(++checks===delayedCheck)s.setNow(1031000n);
      }),/HEADROOM_EXPIRED/);
      assert.equal(s.sent.length,0);
      const record=s.relay.get(s.domain,1n);
      if(delayedCheck===1){assert.equal(record,null);assert.equal(s.prepareCalls(),0);}
      else {assert.equal(record!.state,'QUARANTINED');assert.ok(record!.raw);assert.equal(record!.attempts,0);}
    }finally{s.close();}
  }
});

test('an unknown send mined during identity or retry simulation reconciles the original canonical receipt',async()=>{
  for(const boundary of ['identity','simulation']){
    const s=await setup();try{
      const original=await s.relay.deliver(config,'owner',s.fence,1n);
      if(boundary==='identity'){
        const identity=s.transport.identity;
        s.transport.identity=async domain=>{s.accepted(original.txHash!);return {...await identity(domain),lastSequence:1n,lastObservedAt:1000n};};
      }else s.transport.simulate=async()=>{s.accepted(original.txHash!);throw new Error('DuplicateOrOldSequence');};
      const result=await s.relay.deliver(config,'owner',s.fence,1n);
      assert.equal(result.state,'MINED');assert.equal(result.txHash,original.txHash);
      assert.equal(result.raw,original.raw);assert.equal(result.nonce,original.nonce);
      assert.equal(s.sent.length,1);assert.equal(s.prepareCalls(),1);
    }finally{s.close();}
  }
});

test('a retry simulation failure without its exact receipt does not claim acceptance or send again',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);
    s.transport.simulate=async()=>{throw new Error('SIMULATION_REJECTED');};
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/SIMULATION_REJECTED/);
    const unchanged=s.relay.get(s.domain,1n)!;
    assert.equal(unchanged.state,'UNKNOWN');assert.equal(unchanged.raw,original.raw);
    assert.equal(unchanged.accepted,null);assert.equal(s.sent.length,1);assert.equal(s.prepareCalls(),1);
  }finally{s.close();}
});
test('older unknown packet blocks newer source sequence and shared nonce survives restart',async()=>{
  const s=await setup();let replacement:LocalRelay|undefined;
  try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);
    s.packets.allocate(s.domain,'owner',s.fence,1000100n,n=>candidate(n));
    await signPrepared(s.packets,s.domain,'owner',s.fence,2n,signer,()=>1000100n,1000n);
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,2n),/OLDER_DELIVERY/);
    s.relay.close();s.setNow(1100100n); // expired lease; packet is too old to send again.
    replacement=new LocalRelay(join(s.dir,'relay.sqlite'),s.packets,s.transport,policy,()=>1100100n);await replacement.start();
    assert.equal(replacement.get(s.domain,1n)!.nonce,0n);assert.equal(replacement.get(s.domain,1n)!.raw,original.raw);
    assert.equal(replacement.get(s.domain,1n)!.state,'UNKNOWN');
  }finally{replacement?.close();s.packets.close();rmSync(s.dir,{recursive:true,force:true});}
});
test('restart preserves reserved nonce high-water mark when pending RPC has not seen the send',async()=>{
  const s=await setup();let replacement:LocalRelay|undefined;
  try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);
    // The fixture pending RPC remains zero: no proof this reservation is free.
    s.relay.release();s.relay.close();
    replacement=new LocalRelay(join(s.dir,'relay.sqlite'),s.packets,s.transport,policy,()=>1000100n);
    await replacement.start();await replacement.start();
    s.accepted(original.txHash!);assert.equal((await replacement.reconcile(config,1n)).state,'MINED');
    s.packets.allocate(s.domain,'owner',s.fence,1000100n,n=>candidate(n));
    await signPrepared(s.packets,s.domain,'owner',s.fence,2n,signer,()=>1000100n,1000n);
    const next=await replacement.deliver(config,'owner',s.fence,2n);
    assert.equal(next.nonce,1n);assert.equal(parseTransaction(next.raw!).nonce,1);
    assert.equal(replacement.get(s.domain,1n)!.raw,original.raw);
  }finally{replacement?.close();s.packets.close();rmSync(s.dir,{recursive:true,force:true});}
});
test('changed call or gas spending cannot broadcast; local RPC and chain admission are enforced',async()=>{
  const s=await setup();
  try{
    s.transport.prepare=async req=>sender.signTransaction({type:'eip1559',chainId:31337,to:req.to as Hex,data:'0x',nonce:Number(req.nonce),gas:req.gas,maxFeePerGas:100n,maxPriorityFeePerGas:1n});
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/SIGNED_TRANSACTION_MISMATCH/);
    assert.equal(s.sent.length,0);assert.equal(s.relay.get(s.domain,1n)!.state,'QUARANTINED');
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/RECOVERY_REQUIRED/);
    assert.throws(()=>new LocalRelay(':memory:',s.packets,{...s.transport,rpcUrl:'https://example.com'},policy),/LOCAL_RPC/);
    assert.throws(()=>new LocalRelay(':memory:',s.packets,s.transport,{...policy,maxCostWei:1n}),/POLICY/);
  }finally{s.close();}
});
test('a signing delay past headroom quarantines the reserved nonce and preserves original timestamps',async()=>{
  const s=await setup();
  try{
    const prepare=s.transport.prepare;s.transport.prepare=async request=>{const raw=await prepare(request);s.setNow(1030001n);return raw;};
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/HEADROOM/);
    assert.equal(s.sent.length,0);assert.equal(s.relay.get(s.domain,1n)!.state,'QUARANTINED');
    assert.equal(s.packets.get(s.domain,1n)!.packet.observation.publishedAt,1000n);
  }finally{s.close();}
});
test('expired reservation on restart blocks new nonces across workers while preserving the old signed bytes',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);s.setNow(1031000n);
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/HEADROOM_EXPIRED/);
    const blocked=s.relay.get(s.domain,1n)!;assert.equal(blocked.state,'QUARANTINED');
    assert.equal(blocked.raw,original.raw);assert.equal(blocked.nonce,original.nonce);
    assert.deepEqual(s.packets.get(s.domain,1n),s.signed);
    const d={...s.domain,sourceId:h('99'),rulesHash:h('98')},cfg={...config,destination:{...config.destination!,sourceId:d.sourceId,sourceRulesHash:d.rulesHash}};
    const fence=s.packets.acquire(d,'second',1031000n,100000n);s.packets.reconcile(d,'second',fence,1031000n,{lastSequence:0n,lastObservedAt:0n});
    s.packets.allocate(d,'second',fence,1031000n,sequence=>({...candidate(sequence),domain:d,sourceMs:1031000n,
      observation:{...candidate(sequence).observation,sourceId:d.sourceId,sourceRulesHash:d.rulesHash,observedAt:1031n,publishedAt:1031n}}));
    await signPrepared(s.packets,d,'second',fence,1n,signer,()=>1031000n,1000n);
    const identity=s.transport.identity;s.transport.identity=async()=>({...await identity(d),signer:d.signer,rulesHash:d.rulesHash,
      listing:{...cfg.destination,indexSourceId:d.sourceId,indexSigner:d.signer,indexRulesHash:d.rulesHash,depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad}});
    await assert.rejects(s.relay.deliver(cfg,'second',fence,1n),/RELAY_NONCE_RECOVERY_REQUIRED/);
    assert.equal(s.relay.get(d,1n),null);assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('headroom exhausted while resimulating an existing reservation persists quarantine',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);
    s.transport.simulate=async()=>{s.setNow(1030001n);};
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/HEADROOM_EXPIRED/);
    const blocked=s.relay.get(s.domain,1n)!;
    assert.equal(blocked.state,'QUARANTINED');assert.equal(blocked.reason,'RESERVED_NONCE_HEADROOM_EXPIRED');
    assert.equal(blocked.raw,original.raw);assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('a rejected simulation consumes no transaction nonce and can retry the identical signed observation',async()=>{
  const s=await setup();try{
    s.transport.simulate=async()=>{throw new Error('SIMULATION_REJECTED');};
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/SIMULATION_REJECTED/);
    assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.prepareCalls(),0);assert.equal(s.sent.length,0);
    s.transport.simulate=async()=>{};
    const retry=await s.relay.deliver(config,'owner',s.fence,1n);
    assert.equal(retry.nonce,0n);assert.equal(parseTransaction(retry.raw!).nonce,0);
    assert.equal(s.packets.get(s.domain,1n)!.digest,s.signed.digest);
  }finally{s.close();}
});
test('headroom exhausted during simulation never reserves a nonce or changes the signed packet',async()=>{
  const s=await setup();try{
    s.transport.simulate=async()=>{s.setNow(1030001n);};
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/HEADROOM/);
    assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.prepareCalls(),0);assert.equal(s.sent.length,0);
    assert.deepEqual(s.packets.get(s.domain,1n),s.signed);
  }finally{s.close();}
});

function deferred<T>(){
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
test('identity and simulation overlap and both settle before nonce reservation',async()=>{
  const s=await setup();
  const identity=s.transport.identity,identityGate=deferred<void>(),simulationGate=deferred<void>();
  let identityStarted=false,simulationStarted=false;
  try{
    s.transport.identity=async domain=>{identityStarted=true;await identityGate.promise;return identity(domain);};
    s.transport.simulate=async()=>{simulationStarted=true;await simulationGate.promise;};
    const delivery=s.relay.deliver(config,'owner',s.fence,1n);
    await new Promise(resolve=>setImmediate(resolve));
    const overlapped=identityStarted&&simulationStarted;
    assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.prepareCalls(),0);assert.equal(s.sent.length,0);
    identityGate.resolve();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.prepareCalls(),0);
    simulationGate.resolve();const result=await delivery;
    assert.equal(result.nonce,0n);assert.equal(overlapped,true);
  }finally{identityGate.resolve();simulationGate.resolve();s.close();}
});
test('overlapped read failures preserve identity listing sequence time and freshness priority',async()=>{
  for(const boundary of ['transport','pin','listing','sequence','time','freshness','simulation']){
    const s=await setup(),identity=s.transport.identity;let simulations=0;
    try{
      s.transport.identity=async domain=>{
        if(boundary==='transport')throw Error('IDENTITY_TRANSPORT_FAILED');
        const result=await identity(domain);
        if(boundary==='pin')result.engineCodeHash=h('99');
        if(boundary==='listing')result.listing.indexSigner=sender.address;
        if(boundary==='sequence')result.lastSequence=1n;
        if(boundary==='time')result.lastObservedAt=1001n;
        return result;
      };
      s.transport.simulate=async()=>{simulations++;if(boundary==='freshness')s.setNow(1030001n);throw Error('SIMULATION_FAILED');};
      const expected={transport:/IDENTITY_TRANSPORT_FAILED/,pin:/RELAY_IDENTITY_MISMATCH/,listing:/LISTING/,sequence:/RECEIPT_RECONCILIATION_REQUIRED/,
        time:/BACKWARDS_CHAIN_SOURCE_TIME/,freshness:/RELAY_HEADROOM_EXPIRED/,simulation:/SIMULATION_FAILED/}[boundary]!;
      await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),expected);
      assert.equal(simulations,1);assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.prepareCalls(),0);assert.equal(s.sent.length,0);
      s.transport.identity=identity;s.transport.simulate=async()=>{};s.setNow(1000100n);
      assert.equal((await s.relay.deliver(config,'owner',s.fence,1n)).nonce,0n);
    }finally{s.close();}
  }
});
test('identity rejection waits for the concurrent simulation to settle without reservation',async()=>{
  const s=await setup(),gate=deferred<void>();let simulationStarted=false,settled=false;
  try{
    s.transport.identity=async()=>{throw Error('IDENTITY_TRANSPORT_FAILED');};
    s.transport.simulate=async()=>{simulationStarted=true;await gate.promise;throw Error('SIMULATION_FAILED');};
    const delivery=s.relay.deliver(config,'owner',s.fence,1n);
    const checked=assert.rejects(delivery,/IDENTITY_TRANSPORT_FAILED/).finally(()=>{settled=true;});
    await new Promise(resolve=>setImmediate(resolve));
    const waited=simulationStarted&&!settled;
    gate.resolve();await checked;
    assert.equal(waited,true);assert.equal(s.prepareCalls(),0);assert.equal(s.sent.length,0);assert.equal(s.relay.get(s.domain,1n),null);
  }finally{gate.resolve();s.close();}
});
test('original hash mined during overlapped sequence check wins over simulation failure',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n),identity=s.transport.identity;
    let simulations=0;
    s.transport.identity=async domain=>({...await identity(domain),lastSequence:1n});
    s.transport.simulate=async()=>{simulations++;s.accepted(original.txHash!);throw Error('DUPLICATE_SEQUENCE');};
    const result=await s.relay.deliver(config,'owner',s.fence,1n);
    assert.equal(simulations,1);assert.equal(result.state,'MINED');assert.equal(result.txHash,original.txHash);
    assert.equal(result.raw,original.raw);assert.equal(result.nonce,original.nonce);assert.equal(s.prepareCalls(),1);assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('headroom expiry during overlapped reads outranks simulation error and quarantines only an existing reservation',async()=>{
  for(const reserved of [false,true]){
    const s=await setup();try{
      const original=reserved?await s.relay.deliver(config,'owner',s.fence,1n):null;
      const identity=s.transport.identity,gate=deferred<void>();
      s.transport.identity=async domain=>{await gate.promise;return identity(domain);};
      s.transport.simulate=async()=>{s.setNow(1030001n);gate.resolve();throw Error('SIMULATION_FAILED');};
      await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/RELAY_HEADROOM_EXPIRED/);
      const record=s.relay.get(s.domain,1n);
      if(original){assert.equal(record!.state,'QUARANTINED');assert.equal(record!.raw,original.raw);assert.equal(record!.nonce,original.nonce);}
      else assert.equal(record,null);
      assert.equal(s.prepareCalls(),reserved?1:0);assert.equal(s.sent.length,reserved?1:0);
      assert.deepEqual(s.packets.get(s.domain,1n),s.signed);
    }finally{s.close();}
  }
});
