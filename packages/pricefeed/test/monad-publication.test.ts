import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters,
  parseTransaction, recoverAddress, type Hex } from 'viem';
import { config, reviewed, body, metadata, event } from './publication-fixture.js';
import { createTestnetKey } from '../src/monad-keys.js';
import { MonadTestnetObservationSigner, MonadTestnetTransactionSigner } from '../src/monad-signers.js';
import { MonadTestnetPipeline, MonadTestnetRelay } from '../src/monad-pipeline.js';
import { monadRpcTransport, type MonadSubmissionRpc } from '../src/monad-rpc.js';
import { parseEngineReadAbi } from '../src/monad-preflight.js';
import { monadLifecycleReader } from '../src/monad-lifecycle.js';
import { MonadTestnetPublicationLifecycle } from '../src/lifecycle.js';
import { PacketStore } from '../src/packet-store.js';
import { Journal } from '../src/journal.js';
import { Worker } from '../src/worker.js';
import { rulesHash } from '../src/rules.js';
import { prepareMonadTestnetObservation, prepareObservation, signPrepared } from '../src/publication.js';
import { ACCEPTED_ABI, type DeliveryReceipt } from '../src/receipts.js';
import { INGRESS_ABI, type Observation } from '../src/wire.js';
import { LocalRelay, type RelayPolicy } from '../src/local-relay.js';
import { quoteMonadGas } from '../src/monad-gas-quote.js';
import { parseConfig } from '../src/config.js';
import { planMonadBudget, applyMonadBudget, budgetPlanHash } from '../src/monad-budget.js';
import { json } from '../src/math.js';

const abi=JSON.parse(readFileSync(new URL('../../artifacts/monad-testnet/receiver-abi.json',import.meta.url),'utf8'));
const policy:RelayPolicy={gasCap:800000n,maxFeePerGas:150000000000n,maxPriorityFeePerGas:2000000000n,
  maxCostWei:120000000000000000n,headroomMs:1000n,confirmations:1n,timeoutMs:1000,maxAttempts:3,leaseMs:120000n};
async function setup(maxTransactions=3,runPolicy:RelayPolicy=policy){
  const dir=mkdtempSync(join(tmpdir(),'monad-publication-'));chmodSync(dir,0o700);
  const key=join(dir,'observation-signer.json'),password=join(dir,'signer-password');
  const signerAddress=createTestnetKey(key,password),sender=createTestnetKey(join(dir,'tx-key'),join(dir,'tx-password'));
  const rules={...reviewed};
  const parsedConfig=parseConfig({...config,requiredFeedUntil:config.destination!.scheduledT,destination:{...config.destination!,
    chainId:'10143',signerAddress,sourceRulesHash:rulesHash(rules),abiHash:parseEngineReadAbi(abi).abiHash,engineCodeHash:keccak256('0x6001')}});
  const cfg={...parsedConfig,destination:parsedConfig.destination!};
  const domain={chainId:10143n,engine:cfg.destination.engineAddress,marketId:cfg.destination.marketId,
    sourceId:cfg.destination.sourceId,rulesHash:cfg.destination.sourceRulesHash,signer:signerAddress};
  let now=1000100n,seq=0n,txNonce=0n,observedAt=0n,finalizedSeq=0n,failSend=false,balance=10n**18n,halt=false,autoFinalize=true;
  const receipts=new Map<Hex,DeliveryReceipt>(),sent:Hex[]=[];
  const block=(number:bigint)=>({number,hash:('0x'+number.toString(16).padStart(64,'0')) as Hex,timestamp:now/1000n});
  const rpc:MonadSubmissionRpc={chainId:async()=>10143,code:async()=> '0x6001',
    block:async(selector)=>block('blockNumber' in selector?selector.blockNumber:9n+finalizedSeq),
    read:async(_address,_abi,name)=>name==='listing'?{...cfg.destination,indexSourceId:domain.sourceId,indexSigner:signerAddress,
      indexRulesHash:domain.rulesHash,depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad}
      :name==='halted'?halt:{signer:signerAddress,rulesHash:domain.rulesHash,configured:true,lastSequence:finalizedSeq,
        lastObservedAt:finalizedSeq?observedAt:0n},
    nonce:async()=>txNonce,balance:async()=>balance,simulate:async()=>{},
    send:async(raw)=>{
      sent.push(raw);if(failSend)throw new Error('https://secret-rpc.invalid/token');
      const tx=keccak256(raw),o=decodeFunctionData({abi:INGRESS_ABI,data:parseTransaction(raw).data!}).args[0] as unknown as Observation;
      txNonce=BigInt(parseTransaction(raw).nonce!)+1n;
      seq=o.sequence;observedAt=o.observedAt;if(autoFinalize)finalizedSeq=seq;
      const b=block(9n+seq),packet=packets.get(domain,seq)!;
      receipts.set(tx,{status:'success',transactionHash:tx,blockNumber:b.number,blockHash:b.hash,logs:[{
        address:domain.engine,transactionHash:tx,blockNumber:b.number,blockHash:b.hash,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,b.timestamp,o.priceWad,true,packet.digest])}]});return tx;
    },receipt:async(hash)=>receipts.get(hash)??null};
  const capture=(data:Record<string,unknown>)=>({url:'https://fixture.invalid',receivedAtMs:now,
    latencyMs:0n,body:JSON.stringify(data),headers:{},data,attempts:1});
  let packets:PacketStore,journal:Journal,signer:MonadTestnetObservationSigner,transactionSigner:MonadTestnetTransactionSigner,
    relay:MonadTestnetRelay,pipeline:MonadTestnetPipeline,worker:Worker;
  function open(create:boolean){
    packets=new PacketStore(join(dir,'packets.sqlite'));journal=new Journal(join(dir,'source.sqlite'));
    signer=new MonadTestnetObservationSigner(join(dir,'signer.sqlite'),domain,packets,()=>now,key,password);
    transactionSigner=new MonadTestnetTransactionSigner(join(dir,'transactions.sqlite'),cfg,join(dir,'tx-key'),join(dir,'tx-password'),sender,runPolicy,create);
    const transport=monadRpcTransport('https://fixture.invalid',cfg,abi,transactionSigner,runPolicy,rpc,()=>now);
    relay=new MonadTestnetRelay(join(dir,'relay.sqlite'),packets,transport,runPolicy,
      {maxTransactions,totalMaxCostWei:BigInt(maxTransactions)*runPolicy.maxCostWei},()=>now);
    worker=new Worker(cfg,{event:async()=>capture(event),metadata:async()=>capture(metadata),
      book:async()=>capture({...JSON.parse(body),timestamp:now.toString()})},journal,'collector',()=>now);
    const lifecycle=new MonadTestnetPublicationLifecycle(cfg,journal,'lifecycle',monadLifecycleReader(rpc,cfg,abi,()=>now),30000n,()=>now);
    pipeline=new MonadTestnetPipeline([{worker,rules,signer,lifecycle}],packets,relay,transport,runPolicy,()=>now);
    return {transport};
  }
  const {transport}=open(true);
  const close=()=>{pipeline.close();relay.close();transactionSigner.close();signer.close();packets.close();journal.close();};
  return {dir,cfg,rules,domain,rpc,transport,sender,sent,
    get packets(){return packets;},get pipeline(){return pipeline;},get worker(){return worker;},get relay(){return relay;},
    get journal(){return journal;},
    get signer(){return signer;},get transactionSigner(){return transactionSigner;},
    setBalance:(n:bigint)=>{balance=n;},setFailure:(n:boolean)=>{failSend=n;},setFinalized:(n:bigint)=>{finalizedSeq=n;},
    holdFinality:()=>{autoFinalize=false;},
    setNow:(n:bigint)=>{now=n;},setHalt:()=>{halt=true;},
    restart:()=>{close();open(false);},close:()=>{close();rmSync(dir,{recursive:true,force:true});}};
}
function renewalPolicies(sender:string){
  const old={schemaVersion:'1',sender,relay:JSON.parse(json(policy)),budget:{maxTransactions:3,totalMaxCostWei:'360000000000000000'}};
  const next={...old,relay:{...old.relay,gasSafetyMarginBps:'1000'},budget:{maxTransactions:4,totalMaxCostWei:'480000000000000000',budgetRevision:1}};
  return {old,next};
}
test('budget renewal is read-only to plan, atomic to apply, idempotent, and resumes original signed history',async()=>{
  const s=await setup();let nextRelay:MonadTestnetRelay|undefined,nextPipeline:MonadTestnetPipeline|undefined;
  try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.pipeline.close();
    const first=s.packets.get(s.domain,1n),delivery=s.relay.get(s.domain,1n),{old,next}=renewalPolicies(s.sender);
    const options={config:s.cfg,abi,rpcUrl:'https://fixture.invalid',journalDirectory:s.dir};
    const plan=await planMonadBudget(options,old,next,randomUUID(),'BOUNDED_TEST',s.rpc,()=>1000100n);
    assert.equal(plan.deliveryCount,1);assert.equal(plan.remainingReservationWei,'360000000000000000');
    assert.deepEqual(s.relay.get(s.domain,1n),delivery);assert.equal(s.sent.length,1);
    const result=await applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n);
    assert.equal(result.alreadyApplied,false);assert.equal(result.nextNonce,1n);
    assert.equal((await applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n)).alreadyApplied,true);
    assert.deepEqual(s.packets.get(s.domain,1n),first);assert.deepEqual(s.relay.get(s.domain,1n),delivery);
    await assert.rejects(s.relay.start(),/RELAY_PROFILE_CHANGED/);
    assert.throws(()=>new MonadTestnetRelay(join(s.dir,'relay.sqlite'),s.packets,s.transport,policy,
      {maxTransactions:3,totalMaxCostWei:360000000000000000n},()=>1000100n),/RELAY_PROFILE_CHANGED/);
    const relayPolicy={...policy,gasSafetyMarginBps:1000n};s.rpc.simulate=async()=>100001n;
    const transport=monadRpcTransport('https://fixture.invalid',s.cfg,abi,s.transactionSigner,relayPolicy,s.rpc,()=>1000100n);
    nextRelay=new MonadTestnetRelay(join(s.dir,'relay.sqlite'),s.packets,transport,relayPolicy,
      {maxTransactions:4,totalMaxCostWei:480000000000000000n,budgetRevision:1},()=>1000100n);
    const lifecycle=new MonadTestnetPublicationLifecycle(s.cfg,s.journal,'renewed-lifecycle',monadLifecycleReader(s.rpc,s.cfg,abi,()=>1000100n),30000n,()=>1000100n);
    nextPipeline=new MonadTestnetPipeline([{worker:s.worker,rules:s.rules,signer:s.signer,lifecycle}],s.packets,nextRelay,transport,relayPolicy,()=>1000100n);
    await nextPipeline.start();const update=await nextPipeline.process(await s.worker.poll());
    assert.equal(update.state,'FINALIZED');assert.equal(update.sequence,2n);assert.equal(parseTransaction(s.sent[1]!).nonce,1);
    assert.equal(parseTransaction(s.sent[1]!).gas,110002n);assert.deepEqual(nextRelay.get(s.domain,1n),delivery);
  }finally{nextPipeline?.close();nextRelay?.close();s.close();}
});
test('budget plans reject live writers and changes outside finite budgets and enabling gas estimates',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());
    const options={config:s.cfg,abi,rpcUrl:'https://fixture.invalid',journalDirectory:s.dir},{old,next}=renewalPolicies(s.sender);
    await assert.rejects(planMonadBudget(options,old,next,randomUUID(),'TEST',s.rpc,()=>1000100n),/IDLE_JOURNALS_REQUIRED/);
    s.pipeline.close();
    for(const changed of [{...next,relay:{...next.relay,gasCap:'700000'}},
      {...next,budget:{...next.budget,budgetRevision:2}},
      {...next,budget:{...next.budget,maxTransactions:3}}])
      await assert.rejects(planMonadBudget(options,old,changed,randomUUID(),'TEST',s.rpc,()=>1000100n),/BUDGET_RENEWAL_SCOPE/);
    assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('failed or changed budget plans roll back without changing the profile or reservations',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.pipeline.close();
    const options={config:s.cfg,abi,rpcUrl:'https://fixture.invalid',journalDirectory:s.dir},{old,next}=renewalPolicies(s.sender);
    const plan=await planMonadBudget(options,old,next,randomUUID(),'TEST',s.rpc,()=>1000100n);
    await assert.rejects(applyMonadBudget(options,{...plan,reason:'DIFFERENT'},plan.approvalHash,s.rpc,()=>1000100n),/PLAN_CHANGED/);
    s.setBalance(1n);await assert.rejects(applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n),/NEEDS_TEST_MON/);
    s.setBalance(10n**18n);const nonce=s.rpc.nonce;s.rpc.nonce=async()=>2n;
    await assert.rejects(applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n),/NONCE_CHANGED/);s.rpc.nonce=nonce;
    const db=new DatabaseSync(join(s.dir,'relay.sqlite'));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='relay_budget_audit'").get(),undefined);db.close();
    await s.relay.start();s.relay.release();
    await assert.rejects(applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n),/JOURNALS_CHANGED/);
    assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('budget audit detects deletion/tampering and conflicting replay without another authorization',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.pipeline.close();
    const options={config:s.cfg,abi,rpcUrl:'https://fixture.invalid',journalDirectory:s.dir},{old,next}=renewalPolicies(s.sender);
    const plan=await planMonadBudget(options,old,next,randomUUID(),'TEST',s.rpc,()=>1000100n);
    await applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n);
    const changed={...plan,id:randomUUID()};changed.approvalHash=budgetPlanHash(changed);
    await assert.rejects(applyMonadBudget(options,changed,changed.approvalHash,s.rpc,()=>1000100n),/REVISION_CONFLICT/);
    const db=new DatabaseSync(join(s.dir,'relay.sqlite'));db.exec('DELETE FROM relay_budget_audit');db.close();
    assert.throws(()=>new MonadTestnetRelay(join(s.dir,'relay.sqlite'),s.packets,s.transport,{...policy,gasSafetyMarginBps:1000n},
      {maxTransactions:4,totalMaxCostWei:480000000000000000n,budgetRevision:1},()=>1000100n),/BUDGET_AUDIT_INTEGRITY/);
  }finally{s.close();}
});
test('applying a budget plan locks every journal through chain checks and commits only the relay policy',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.pipeline.close();
    const options={config:s.cfg,abi,rpcUrl:'https://fixture.invalid',journalDirectory:s.dir},{old,next}=renewalPolicies(s.sender);
    const plan=await planMonadBudget(options,old,next,randomUUID(),'TEST_LOCKS',s.rpc,()=>1000100n);
    const nonce=s.rpc.nonce;let checked=0;
    s.rpc.nonce=async()=>{
      for(const name of ['source','packets','signer','transactions','relay']){
        const competitor=new DatabaseSync(join(s.dir,name+'.sqlite'),{timeout:1});
        try{assert.throws(()=>competitor.exec('BEGIN IMMEDIATE'),/locked|busy/);checked++;}
        finally{competitor.close();}
      }
      return nonce('0x0000000000000000000000000000000000000001');
    };
    await applyMonadBudget(options,plan,plan.approvalHash,s.rpc,()=>1000100n);assert.equal(checked,5);
    s.rpc.nonce=nonce;
    const nextAgain={...next,budget:{maxTransactions:5,totalMaxCostWei:'600000000000000000',budgetRevision:2}};
    const second=await planMonadBudget(options,next,nextAgain,randomUUID(),'SECOND_BUDGET',s.rpc,()=>1000100n);
    assert.equal((await applyMonadBudget(options,second,second.approvalHash,s.rpc,()=>1000100n)).revision,2);
    const db=new DatabaseSync(join(s.dir,'relay.sqlite'));assert.equal(db.prepare('SELECT count(*) AS n FROM relay_budget_audit').get()!.n,2);db.close();
    assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('testnet pipeline signs real raw digests, sends chain-10143 transactions and resumes journal/nonces after restart',async()=>{
  const s=await setup();try{
    await s.pipeline.start();const first=await s.pipeline.process(await s.worker.poll());assert.equal(first.state,'FINALIZED');
    assert.equal(first.sequence,1n);assert.equal(parseTransaction(s.sent[0]!).chainId,10143);
    const packet=s.packets.get(s.domain,1n)!;
    assert.equal((await recoverAddress({hash:packet.digest,signature:packet.signature!})).toLowerCase(),s.domain.signer.toLowerCase());
    s.restart();await s.pipeline.start();const second=await s.pipeline.process(await s.worker.poll());
    assert.equal(second.state,'FINALIZED');assert.equal(second.sequence,2n);assert.equal(parseTransaction(s.sent[1]!).nonce,1);
    assert.deepEqual(s.packets.get(s.domain,1n),packet);
  }finally{s.close();}
});
test('estimated testnet gas is rounded up, verified at the selected limit and preserved after unknown-send restart',async()=>{
  const s=await setup(3,{...policy,gasSafetyMarginBps:1000n});try{
    const limits:bigint[]=[];
    s.rpc.simulate=async(_sender,_to,_data,gas)=>{limits.push(gas);return 100001n;};
    s.setFailure(true);await s.pipeline.start();
    const result=await s.pipeline.process(await s.worker.poll());assert.equal(result.state,'UNKNOWN');
    const first=s.relay.get(s.domain,1n)!;
    assert.equal(first.request!.gas,110002n);assert.deepEqual(first.gasSizing,{estimatedGas:100001n,gasLimit:110002n,marginBps:1000n});
    assert.deepEqual(limits,[800000n,110002n]);
    s.restart();s.rpc.simulate=async(_sender,_to,_data,gas)=>{limits.push(gas);return 105000n;};
    s.setFailure(false);await s.pipeline.start();
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'FINALIZED');
    assert.equal(s.sent[1],first.raw);assert.equal(s.relay.get(s.domain,1n)!.request!.gas,110002n);
    assert.equal(limits.at(-1),110002n);
  }finally{s.close();}
});
test('optimized gas failures reserve no transaction nonce and never fall back to the full cap',async()=>{
  for(const estimate of [undefined,0n,20999n,727273n,800001n]){
    const s=await setup(3,{...policy,gasSafetyMarginBps:1000n});try{
      s.rpc.simulate=async()=>estimate;await s.pipeline.start();
      await assert.rejects(s.pipeline.process(await s.worker.poll()),/MONAD_(GAS_ESTIMATE_REQUIRED|GAS_CAP_EXCEEDED)/);
      assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.sent.length,0);
    }finally{s.close();}
  }
});
test('a selected gas limit that fails simulation cannot consume a nonce',async()=>{
  const s=await setup(3,{...policy,gasSafetyMarginBps:1000n});try{
    s.rpc.simulate=async(_sender,_to,_data,gas)=>{if(gas<800000n)throw new Error('out of gas');return 100000n;};
    await s.pipeline.start();await assert.rejects(s.pipeline.process(await s.worker.poll()),/MONAD_SIMULATION_FAILED/);
    assert.equal(s.relay.get(s.domain,1n),null);assert.equal(s.sent.length,0);
  }finally{s.close();}
});
test('gas quote records an expired signed packet without sending or consuming a transaction nonce',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.pipeline.close();
    s.rpc.simulate=async()=>100001n;
    const capture=(data:Record<string,unknown>)=>({url:'https://fixture.invalid',receivedAtMs:1000200n,
      latencyMs:0n,body:JSON.stringify(data),headers:{},data,attempts:1});
    const result=await quoteMonadGas({config:s.cfg,rules:s.rules,abi,rpcUrl:'https://fixture.invalid',
      keysDirectory:s.dir,journalDirectory:s.dir,policy:{sender:s.sender,relay:{...policy,gasSafetyMarginBps:1000n},
        budget:{maxTransactions:3,totalMaxCostWei:360000000000000000n}}},s.rpc,
      {event:async()=>capture(event),metadata:async()=>capture(metadata),book:async()=>capture({...JSON.parse(body),timestamp:'1000100'})},()=>1000200n);
    assert.equal(result.sequence,2n);assert.equal(result.sizing.gasLimit,110002n);
    assert.equal(result.nonceBefore,result.nonceAfter);assert.equal(result.transactionsSent,0);
    assert.equal(s.sent.length,1);assert.equal(s.relay.get(s.domain,2n),null);
    assert.equal(s.packets.get(s.domain,2n)!.state,'EXPIRED');assert.ok(s.packets.get(s.domain,2n)!.signature);
    s.restart();await s.pipeline.start();assert.equal((await s.pipeline.process(await s.worker.poll())).sequence,3n);
    assert.equal(parseTransaction(s.sent[1]!).nonce,1);
    s.restart();await s.pipeline.start();assert.equal((await s.pipeline.process(await s.worker.poll())).sequence,4n);
    assert.equal(parseTransaction(s.sent[2]!).nonce,2);
  }finally{s.close();}
});
test('testnet source history mismatch persists quarantine and prevents restart publication',async()=>{
  const s=await setup();try{
    s.setFinalized(7n);await assert.rejects(s.pipeline.start(),/UNKNOWN_CHAIN_SEQUENCE/);
    s.restart();await assert.rejects(s.pipeline.start(),/RELAY_PERSISTENT_QUARANTINE/);assert.equal(s.sent.length,0);
  }finally{s.close();}
});
test('testnet receipt remains MINED until a finalized head includes its canonical block',async()=>{
  const s=await setup();try{
    s.holdFinality();await s.pipeline.start();assert.equal((await s.pipeline.process(await s.worker.poll())).state,'MINED');
    assert.equal((await s.relay.reconcile(s.cfg,1n)).state,'MINED');
    s.setFinalized(1n);assert.equal((await s.relay.reconcile(s.cfg,1n)).state,'FINALIZED');
  }finally{s.close();}
});
test('testnet total budget survives restart and stops allocation after the last accepted packet',async()=>{
  const s=await setup(1);try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());s.restart();await s.pipeline.start();
    assert.equal((await s.pipeline.process(await s.worker.poll())).reason,'TESTNET_RELAY_BUDGET_EXHAUSTED');
    assert.equal(s.packets.list(s.domain).length,1);assert.equal(s.sent.length,1);
  }finally{s.close();}
});
test('unfunded testnet simulation reserves no nonce and broadcasts nothing',async()=>{
  const s=await setup();try{
    s.setBalance(0n);await s.pipeline.start();await assert.rejects(s.pipeline.process(await s.worker.poll()),/MONAD_SENDER_NEEDS_TEST_MON/);
    assert.equal(s.sent.length,0);assert.equal(s.relay.get(s.domain,1n),null);
  }finally{s.close();}
});
test('unknown testnet send preserves immutable raw transaction and redacts RPC credentials',async()=>{
  const s=await setup();try{
    s.setFailure(true);await s.pipeline.start();const result=await s.pipeline.process(await s.worker.poll());
    assert.equal(result.state,'UNKNOWN');assert.equal(result.reason,'MONAD_BROADCAST_RESULT_UNKNOWN');
    const raw=s.relay.get(s.domain,1n)!.raw;s.setFailure(false);
    assert.equal((await s.pipeline.process(await s.worker.poll())).state,'FINALIZED');assert.equal(s.sent[1],raw);
  }finally{s.close();}
});
test('original local builder/signing/relay cannot be used for external testnet output',async()=>{
  const s=await setup();try{
    assert.throws(()=>prepareObservation(s.cfg,s.rules,{bookBody:body,metadata,event,bookReceivedAtMs:1000000n,
      metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},1n,1000100n,1000n),/DEVELOPMENT_CHAIN_ONLY/);
    await assert.rejects(signPrepared(s.packets,s.domain,'owner',1n,1n,s.signer,()=>1000100n,1000n),/DEVELOPMENT_CHAIN_ONLY/);
    assert.throws(()=>new LocalRelay(join(s.dir,'bad.sqlite'),s.packets,s.transport,policy),/LOCAL_RPC_ONLY/);
    const packet=prepareMonadTestnetObservation(s.cfg,s.rules,{bookBody:body,metadata,event,bookReceivedAtMs:1000000n,
      metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},1n,1000100n,1000n);
    assert.equal(packet.domain.chainId,10143n);
  }finally{s.close();}
});
test('testnet transaction signer cannot sign a transfer, another receiver or an excessive fee request',async()=>{
  const s=await setup();try{
    await s.pipeline.start();await s.pipeline.process(await s.worker.poll());
    const request=s.relay.get(s.domain,1n)!.request!;
    await assert.rejects(s.transactionSigner.sign({...request,to:'0x'+'12'.repeat(20),nonce:2n}),/TESTNET_TRANSACTION_SCOPE/);
    await assert.rejects(s.transactionSigner.sign({...request,data:'0x1234',nonce:2n}),/TESTNET_TRANSACTION_SCOPE/);
    await assert.rejects(s.transactionSigner.sign({...request,maxFeePerGas:policy.maxFeePerGas+1n,nonce:2n}),/TESTNET_TRANSACTION_SCOPE/);
  }finally{s.close();}
});
