/** Read-only sustained campaign verification against a closed archive and named phase blocks. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, http, keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { monadTestnet } from 'viem/chains';
import { parseConfig } from '../src/config.js';
import { json } from '../src/math.js';
import { observationDigest, submitCalldata } from '../src/wire.js';
import { validateReceipt } from '../src/receipts.js';
import { monadSubmissionRpc } from '../src/monad-rpc.js';
import { preflightMonadTestnet } from '../src/monad-preflight.js';
import { parseTestnetRunPolicy } from '../src/monad-service.js';
import { PacketStore, packetNamespace, type PreparedPacket } from '../src/packet-store.js';
import { parseTransactionRequest } from '../src/durable-transaction-signer.js';
import { policyHash, relayProfileBody, verifyBudgetAudit } from '../src/relay-policy.js';
import { sizeGas } from '../src/gas.js';
import { replayCoverage, reviewCoveragePhases, type CoverageSample, type CoverageCheckpoint } from './monad-coverage.js';
import { nonceRecoveries, validateCancellationReceipt, verifyCancellationSigner } from '../src/nonce-recovery-journal.js';
import { budgetPlanHash } from '../src/monad-budget.js';

const args=process.argv.slice(2);
assert.ok(args.every(arg=>['--initial-only','--retry'].includes(arg))&&new Set(args).size===args.length,'unsupported report option');
const initialOnly=args.includes('--initial-only'),retry=args.includes('--retry'),prefix=retry?'coverage-retry':'coverage';
const root='artifacts/monad-testnet/',archive=`var/monad-testnet/${prefix}-${initialOnly?'initial':'run'}-evidence/`;
const read=(name:string)=>JSON.parse(readFileSync(root+name,'utf8'));
const cfg=parseConfig(read('market-config.json')),d=cfg.destination!,abi=read('receiver-abi.json');
const policyRaw=read(prefix+'-policy.json'),policy=parseTestnetRunPolicy(policyRaw),plan=read(prefix+'-budget-plan.json');
assert.equal(budgetPlanHash(plan),plan.approvalHash);assert.deepEqual(plan.nextPolicy,policyRaw);
const baselineBytes=readFileSync(root+(retry?'coverage-initial-run.json':'optimized-small-run.json')),baseline=JSON.parse(baselineBytes.toString());
assert.equal(baseline.archive,retry?'var/monad-testnet/coverage-initial-evidence/':'var/monad-testnet/optimized-run-evidence/');
for(const [name,checksum] of Object.entries(baseline.archiveSha256))
  assert.equal(createHash('sha256').update(readFileSync(baseline.archive+name)).digest('hex'),checksum,'baseline archive changed');
const phaseFiles=(initialOnly?['initial']:['initial','gap','recovered']).map(phase=>`${prefix}-${phase}.json`);
const rawChecks=phaseFiles.map(read);
const rpcUrl=process.env.PRICEFEED_MONAD_RPC_URL;assert.ok(rpcUrl,'RPC environment required');
const rpc=monadSubmissionRpc(rpcUrl),client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{retryCount:0})});
const archiveSha256=Object.fromEntries(['source.sqlite','packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite']
  .map(name=>{
    assert.ok(!existsSync(archive+name+'-wal')||readFileSync(archive+name+'-wal').length===0,'archive has uncheckpointed WAL');
    return [name,createHash('sha256').update(readFileSync(archive+name)).digest('hex')];
  }));
const relay=new DatabaseSync(archive+'relay.sqlite',{readOnly:true});
const transactions=new DatabaseSync(archive+'transactions.sqlite',{readOnly:true});
const signer=new DatabaseSync(archive+'signer.sqlite',{readOnly:true});
const source=new DatabaseSync(archive+'source.sqlite',{readOnly:true});
const packets=new PacketStore(archive+'packets.sqlite',true);
try{
  assert.equal(packets.verify(),true);
  const profile=relayProfileBody({chainId:10143n,...policy.budget},policy.relay);
  assert.equal(relay.prepare('SELECT profile FROM relay_control WHERE id=1').get()!.profile,profile);
  verifyBudgetAudit(relay,profile,policy.budget.budgetRevision);
  const recoveries=nonceRecoveries(relay);assert.ok(recoveries.every(r=>r.state==='FINALIZED'));
  for(const old of baseline.recoveries)assert.deepEqual(recoveries.find(r=>r.key===old.key),old,'historical cancellation changed');
  const audit=JSON.parse(String(relay.prepare('SELECT body FROM relay_budget_audit WHERE revision=?').get(policy.budget.budgetRevision!)!.body));
  assert.equal(audit.approvalHash,plan.approvalHash);
  const domain={chainId:10143n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  const inventory=packets.list(domain),rows=relay.prepare('SELECT body,sha256 FROM deliveries').all();
  const deliveries=rows.map(row=>{assert.equal(policyHash(String(row.body)),row.sha256);return JSON.parse(String(row.body));})
    .sort((a,b)=>Number(BigInt(a.nonce)-BigInt(b.nonce)));
  assert.ok(deliveries.length>baseline.deliveries.length&&deliveries.length+recoveries.length<=policy.budget.maxTransactions,'no campaign samples or count cap exceeded');
  assert.deepEqual(deliveries.slice(0,baseline.deliveries.length),baseline.deliveries,'previous signed deliveries changed');
  assert.equal(transactions.prepare('SELECT count(*) AS count FROM transaction_reservations').get()!.count,deliveries.length);
  const checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi}),receipts=[];
  const items:{packet:PreparedPacket;digest:Hex;signature:Hex;state:string;delivery:any}[]=[];
  const signerRows=signer.prepare('SELECT * FROM signer_reservations').all();
  assert.equal(signerRows.length,inventory.filter(p=>p.signature).length);
  for(const row of signerRows){
    const saved=inventory.find(p=>p.packet.observation.sequence.toString()===row.sequence);
    assert.ok(saved?.signature);assert.equal(saved.digest,row.digest);assert.equal(saved.signature,row.signature);
    assert.equal(row.ns,packetNamespace(saved.packet.domain));assert.equal(row.identity,row.ns+':'+row.sequence);
    assert.equal(policyHash(`${row.identity}:${row.digest}:${row.signature}`),row.sha256);
  }
  const historicalNonces=new Set(baseline.deliveries.map((r:{nonce:string})=>r.nonce));
  const historicalRecoveries=new Set(baseline.recoveries.map((r:{key:string})=>r.key));
  let totalCost=0n,optimizedCost=0n,recoveryCost=0n,reserved=0n,newReserved=0n;
  for(let i=0;i<deliveries.length;i++){
    const delivery=deliveries[i]!,saved=inventory.find(p=>p.packet.observation.sequence.toString()===delivery.sequence);
    assert.ok(saved?.signature);const packet=saved.packet,request=parseTransactionRequest(delivery.request);
    assert.ok(['FINALIZED','CANCELLED'].includes(delivery.state));assert.equal(request.nonce,BigInt(i));
    assert.equal(observationDigest(packet.observation,10143n,d.engineAddress),saved.digest);
    assert.equal(saved.digest,delivery.digest);
    assert.equal((await recoverAddress({hash:saved.digest,signature:saved.signature})).toLowerCase(),d.signerAddress.toLowerCase());
    const raw=delivery.raw as TransactionSerialized,hash=delivery.txHash as Hex,tx=parseTransaction(raw);
    assert.equal(keccak256(raw),hash);assert.equal((await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase(),policy.sender.toLowerCase());
    assert.equal(tx.chainId,10143);assert.equal(tx.nonce,i);assert.equal(tx.to!.toLowerCase(),d.engineAddress.toLowerCase());
    assert.equal(tx.value??0n,0n);assert.equal(tx.data,submitCalldata(packet.observation,saved.signature));
    assert.equal(tx.gas,request.gas);assert.equal(tx.maxFeePerGas,request.maxFeePerGas);assert.equal(tx.maxPriorityFeePerGas,request.maxPriorityFeePerGas);
    const signed=transactions.prepare('SELECT * FROM transaction_reservations WHERE nonce=?').get(String(i))!;
    assert.equal(signed.request,json(request));assert.equal(signed.raw,raw);assert.equal(signed.tx_hash,hash);
    assert.equal(signed.sha256,policyHash(`${signed.request}:${signed.raw}:${signed.tx_hash}`));
    const reservation=request.gas*request.maxFeePerGas;
    assert.ok(request.gas<=policy.relay.gasCap&&request.maxFeePerGas<=policy.relay.maxFeePerGas
      &&request.maxPriorityFeePerGas<=policy.relay.maxPriorityFeePerGas&&reservation<=policy.relay.maxCostWei);
    reserved+=reservation;
    const item={packet,digest:saved.digest,signature:saved.signature,state:saved.state,delivery};
    if(i>=3){
      assert.ok(delivery.gasSizing);assert.equal(BigInt(delivery.gasSizing.marginBps),policy.relay.gasSafetyMarginBps);
      assert.equal(sizeGas(BigInt(delivery.gasSizing.estimatedGas),policy.relay.gasCap,policy.relay.gasSafetyMarginBps!).gasLimit,request.gas);
      assert.equal(BigInt(delivery.gasSizing.gasLimit),request.gas);if(!historicalNonces.has(delivery.nonce))newReserved+=reservation;
    }
    if(delivery.state==='CANCELLED'){
      assert.ok(recoveries.some(r=>r.nonce===String(i)));assert.equal(delivery.accepted,null);continue;
    }
    const receipt=await rpc.receipt(hash);assert.ok(receipt);assert.ok(receipt.blockNumber<=checkpoint.block.number);
    const block=await rpc.block({blockNumber:receipt.blockNumber});
    const accepted=validateReceipt(packet,hash,receipt,block,{depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad)});
    assert.equal(json(accepted),json(delivery.accepted));
    const full=await client.getTransactionReceipt({hash});assert.equal(full.blockHash,receipt.blockHash);assert.equal(full.status,'success');
    const cost=full.gasUsed*full.effectiveGasPrice;assert.ok(cost<=reservation);totalCost+=cost;if(!historicalNonces.has(delivery.nonce))optimizedCost+=cost;
    receipts.push({nonce:i,sequence:packet.observation.sequence,receipt,gasLimit:request.gas,gasUsed:full.gasUsed,
      effectiveGasPrice:full.effectiveGasPrice,gasCostWei:cost,reservationWei:reservation,accepted});items.push(item);
  }
  const recoveryReceipts=[];
  for(const r of recoveries){
    await verifyCancellationSigner(r);const receipt=await rpc.receipt(r.hash!);assert.ok(receipt);validateCancellationReceipt(r,receipt);
    assert.ok(receipt.blockNumber<=checkpoint.block.number);assert.equal((await rpc.block({blockNumber:receipt.blockNumber})).hash,receipt.blockHash);
    assert.equal(json(receipt),json(r.receipt));const full=await client.getTransactionReceipt({hash:r.hash!});
    assert.equal(full.blockHash,receipt.blockHash);const cost=full.gasUsed*full.effectiveGasPrice;
    assert.ok(cost<=BigInt(r.reservationWei));totalCost+=cost;recoveryCost+=cost;reserved+=BigInt(r.reservationWei);if(!historicalRecoveries.has(r.key))newReserved+=BigInt(r.reservationWei);
    recoveryReceipts.push({receipt,gasUsed:full.gasUsed,effectiveGasPrice:full.effectiveGasPrice,gasCostWei:cost,reservationWei:r.reservationWei});
  }
  assert.ok(reserved<=policy.budget.totalMaxCostWei&&newReserved<=BigInt(plan.remainingReservationWei));
  // A revision can retain unused slots from the previous policy. The ceiling
  // increase is distinct from the actual slots remaining at this checkpoint.
  assert.ok(deliveries.length+recoveries.length-plan.deliveryCount<=policy.budget.maxTransactions-plan.deliveryCount);
  assert.deepEqual(JSON.parse(json(items.slice(0,baseline.packets.length))),baseline.packets,'old packet/signature/receipt changed');
  assert.equal(reserved-newReserved,BigInt(plan.reservedWei));
  const oldRecoveryCost=BigInt(baseline.recoveryGasCostWei);
  assert.ok(optimizedCost+recoveryCost-oldRecoveryCost<=BigInt(plan.remainingReservationWei));
  const latest=items.at(-1)!.packet.observation;
  assert.equal(checkpoint.engine!.sourceState.lastSequence,latest.sequence);assert.equal(checkpoint.engine!.sourceState.lastObservedAt,latest.observedAt);
  assert.equal(await rpc.nonce(policy.sender as Hex),BigInt(deliveries.length));
  const captures=source.prepare('SELECT payload,sha256 FROM captures ORDER BY id').all().map(row=>{
    assert.equal(policyHash(String(row.payload)),row.sha256);return JSON.parse(String(row.payload));});
  assert.deepEqual(captures.slice(0,baseline.captures.length),baseline.captures,'previous source archive changed');
  const checks:CoverageCheckpoint[]=[];
  for(const raw of rawChecks){
    assert.equal(raw.mode,'MONAD_TESTNET_COVERAGE_CHECKPOINT');assert.equal(raw.chainId,10143);
    assert.equal(raw.engine.toLowerCase(),d.engineAddress.toLowerCase());
    assert.equal(raw.transactionsSent,0);assert.equal(raw.signaturesProduced,0);assert.equal(raw.productionApproved,false);
    const block=await rpc.block({blockNumber:BigInt(raw.block.number)});
    assert.equal(json(block),json(raw.block));assert.ok(block.number<=checkpoint.block.number);
    const namedRpc={...rpc,block:async(selector:Parameters<typeof rpc.block>[0])=>
      'blockTag' in selector?block:rpc.block(selector)};
    const named=await preflightMonadTestnet(namedRpc,{config:cfg,abi},()=>block.timestamp*1000n);
    assert.equal(json(named.engine!.sourceState),json(raw.sourceState));
    const actual=await client.readContract({address:d.engineAddress as Hex,abi,functionName:'indexTwap300',
      args:[block.timestamp],blockNumber:block.number});
    assert.equal(json(actual),json(raw.actual));
    assert.equal(json(await rpc.block({blockNumber:block.number})),json(block));
    checks.push({phase:raw.phase,block,actual:actual as CoverageCheckpoint['actual'],
      sourceState:{lastSequence:BigInt(raw.sourceState.lastSequence),lastObservedAt:BigInt(raw.sourceState.lastObservedAt)}});
  }
  const samples:CoverageSample[]=receipts.map((r,i)=>({sequence:items[i]!.packet.observation.sequence,
    observedAt:items[i]!.packet.observation.observedAt,acceptedAt:r.accepted.acceptedAt,
    blockNumber:r.accepted.blockNumber,logIndex:r.accepted.logIndex,priceWad:r.accepted.priceWad,valid:r.accepted.depthValid}));
  // All candidate receipt windows are retained, including failed windows. A failed
  // required phase writes truthful evidence and exits nonzero instead of hiding it.
  const candidateWindows=[];
  for(const r of receipts.filter(r=>!historicalNonces.has(String(r.nonce)))){
    const block=await rpc.block({blockNumber:r.accepted.blockNumber});
    const actual=await client.readContract({address:d.engineAddress as Hex,abi,functionName:'indexTwap300',
      args:[block.timestamp],blockNumber:block.number});
    candidateWindows.push({block,actual});
  }
  let acceptance:{verified:boolean;failure?:string}={verified:false};
  if(initialOnly){
    assert.equal(checks[0]!.phase,'initial');
    assert.deepEqual(checks[0]!.actual,replayCoverage(samples,checks[0]!.block));
    acceptance={verified:false,failure:'INITIAL_COVERAGE_FAILED_RECOVERY_NOT_RUN'};
    assert.equal(checks[0]!.actual.available,false,'use complete campaign report after an initial pass');
  }else{
    try{acceptance=reviewCoveragePhases(samples,checks);}catch{acceptance={verified:false,failure:'COVERAGE_PHASE_REQUIREMENTS_FAILED'};}
  }
  for(const [name,checksum] of Object.entries(archiveSha256))assert.equal(createHash('sha256').update(readFileSync(archive+name)).digest('hex'),checksum,'archive changed');
  const report={mode:'MONAD_TESTNET_SUSTAINED_COVERAGE_DIAGNOSTIC',verifiedAtUtc:new Date().toISOString(),chainId:10143,
    config:cfg,sender:policy.sender,policy:policyRaw,approvedPlanHash:plan.approvalHash,archive,archiveSha256,captures,packets:items,receipts,checkpoint,
    deliveries,recoveries,recoveryReceipts,recoveryGasCostWei:recoveryCost,newGasCostWei:optimizedCost+recoveryCost-oldRecoveryCost,
    transactionsFinalized:items.length,optimizedTransactionsFinalized:items.length-baseline.transactionsFinalized,totalGasCostWei:totalCost,
    optimizedGasCostWei:optimizedCost,historicalReservationsWei:BigInt(plan.reservedWei),newReservationsWei:newReserved,
    previousSignedPacketsAndTransactionsUnchanged:true,evidenceVerified:true,initialOnly,retry,
    baselineEvidenceSha256:createHash('sha256').update(baselineBytes).digest('hex'),checks:rawChecks,candidateWindows,acceptance,
    productionApproved:false,humanGatesAccepted:false,limitations:['One diagnostic politics listing; production cadence, category/load calibration and hosting remain unapproved.']};
  writeFileSync(root+prefix+(initialOnly?'-initial-run.json':'-run.json'),json(report)+'\n');
  console.log(json({verified:acceptance.verified,optimizedTransactionsFinalized:items.length-baseline.transactionsFinalized,optimizedGasCostWei:optimizedCost,
    newReservationsWei:newReserved,acceptance,productionApproved:false}));
  if(!acceptance.verified)process.exitCode=2;
}finally{packets.close();source.close();signer.close();transactions.close();relay.close();}
