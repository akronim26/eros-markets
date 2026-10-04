import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { keccak256 } from 'viem';
import { LocalTransactionSigner } from '../src/local-transaction-signer.js';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy } from '../src/local-relay.js';
import { PacketStore } from '../src/packet-store.js';
import { signPrepared } from '../src/publication.js';
import { json } from '../src/math.js';
import { candidate, config, signer } from './publication-fixture.js';

const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
  headroomMs:1000n,confirmations:2n,timeoutMs:1000,maxAttempts:3,leaseMs:100000n};
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-transaction-relay-')),path=(s:string)=>join(dir,s+'.sqlite');
  let now=1000100n;
  const packets=new PacketStore(path('packets')),domain=candidate(1n).domain,fence=packets.acquire(domain,'owner',now,100000n);
  packets.reconcile(domain,'owner',fence,now,{lastSequence:0n,lastObservedAt:0n});packets.allocate(domain,'owner',fence,now,n=>candidate(n));
  await signPrepared(packets,domain,'owner',fence,1n,signer,()=>now,1000n);
  let transactions=new LocalTransactionSigner(path('transactions'),true);transactions.close();
  copyFileSync(path('transactions'),path('old-transactions'));transactions=new LocalTransactionSigner(path('transactions'));
  let sends=0;
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:transactions.address,transactionJournal:transactions,
    pendingNonce:async()=>0n,identity:async()=>({chainId:31337n,engineCodeHash:config.destination!.engineCodeHash,abiHash:config.destination!.abiHash,
      signer:domain.signer,rulesHash:domain.rulesHash,lastSequence:0n,lastObservedAt:0n,
      listing:{...config.destination,indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
        depthNLots:config.pricing.depthNLots,maxSpreadWad:config.pricing.maxSpreadWad}}),
    simulate:async()=>{},prepare:request=>transactions.sign(request),broadcast:async raw=>{sends++;return keccak256(raw);},
    receipt:async()=>null,block:async()=>null,head:async()=>0n};
  let relay=new LocalRelay(path('relay'),packets,transport,policy,()=>now);await relay.start();relay.release();relay.close();
  copyFileSync(path('relay'),path('old-relay'));relay=new LocalRelay(path('relay'),packets,transport,policy,()=>now);await relay.start();
  return {dir,path,packets,domain,fence,transport,get relay(){return relay;},get transactions(){return transactions;},sends:()=>sends,
    setNow:(n:bigint)=>{now=n;},
    reopenRelay:async(t=transport,file=path('relay'))=>{relay.release();relay.close();relay=new LocalRelay(file,packets,t,policy,()=>now);await relay.start();},
    restoreTransactions:()=>{transactions.close();transactions=new LocalTransactionSigner(path('old-transactions'));transport.transactionJournal=transactions;},
    close:()=>{relay.release();relay.close();transactions.close();packets.close();rmSync(dir,{recursive:true,force:true});}};
}
test('restored relay snapshot behind independently signed transactions cannot start or send',async()=>{
  const s=await setup();try{
    await s.relay.deliver(config,'owner',s.fence,1n);const sends=s.sends();
    await assert.rejects(s.reopenRelay(s.transport,s.path('old-relay')),/SIGNER_AHEAD_OR_MISMATCH/);
    assert.equal(s.sends(),sends);
  }finally{s.close();}
});
test('restored signer snapshot behind relay raw bytes blocks startup',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n);s.restoreTransactions();
    await assert.rejects(s.reopenRelay(),/SIGNER_BEHIND_RELAY/);
    assert.equal(s.relay.get(s.domain,1n)!.raw,original.raw);assert.equal(s.sends(),1);
  }finally{s.close();}
});
test('pinned transaction signer cannot be disabled or replaced with an empty journal',async()=>{
  const s=await setup();let replacement:LocalTransactionSigner|undefined;try{
    const plain={...s.transport};delete plain.transactionJournal;
    await assert.rejects(s.reopenRelay(plain),/RELAY_TRANSACTION_SIGNER_CHANGED/);
    replacement=new LocalTransactionSigner(s.path('replacement'),true);
    await assert.rejects(s.reopenRelay({...s.transport,transactionJournal:replacement}),/RELAY_TRANSACTION_SIGNER_CHANGED/);
    assert.equal(s.sends(),0);
  }finally{replacement?.close();s.close();}
});
test('durable signer recovery still quarantines an expired PREPARING checkpoint',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n),packet=s.packets.get(s.domain,1n);
    s.relay.release();
    // Reconstruct the relay state of TX_SIGNED: backend kept raw, relay had not.
    const r={...original,state:'PREPARING',raw:null,txHash:null,attempts:0,accepted:null,reason:null};
    const body=json(r),db=new DatabaseSync(s.path('relay'));
    db.prepare('UPDATE deliveries SET body=?,sha256=?').run(body,createHash('sha256').update(body).digest('hex'));db.close();
    s.setNow(1030001n);await s.reopenRelay();assert.equal(s.relay.canResumePreparing(s.domain,1n),true);
    await assert.rejects(s.relay.deliver(config,'owner',s.fence,1n),/HEADROOM_EXPIRED/);
    assert.equal(s.relay.get(s.domain,1n)!.state,'QUARANTINED');assert.deepEqual(s.packets.get(s.domain,1n),packet);
    assert.equal(s.sends(),1);assert.equal(await s.transactions.sign(original.request!),original.raw);
  }finally{s.close();}
});
test('restored signer reservation cannot silently change stored calldata or gas policy',async()=>{
  const s=await setup();try{
    const original=await s.relay.deliver(config,'owner',s.fence,1n),r={...original,request:{...original.request!,gas:99999n}};
    const body=json(r),db=new DatabaseSync(s.path('relay'));
    db.prepare('UPDATE deliveries SET body=?,sha256=?').run(body,createHash('sha256').update(body).digest('hex'));db.close();
    await assert.rejects(s.reopenRelay(),/SIGNER_AHEAD_OR_MISMATCH/);assert.equal(s.sends(),1);
  }finally{s.close();}
});
test('legacy relay history requires explicit migration before attaching a transaction journal',async()=>{
  const s=await setup();let legacy:LocalRelay|undefined;try{
    const plain={...s.transport};delete plain.transactionJournal;
    legacy=new LocalRelay(s.path('legacy'),s.packets,plain,policy,()=>1000100n);await legacy.start();
    await legacy.deliver(config,'owner',s.fence,1n);legacy.release();legacy.close();
    legacy=new LocalRelay(s.path('legacy'),s.packets,s.transport,policy,()=>1000100n);
    await assert.rejects(legacy.start(),/MIGRATION_REQUIRED/);
  }finally{legacy?.release();legacy?.close();s.close();}
});
