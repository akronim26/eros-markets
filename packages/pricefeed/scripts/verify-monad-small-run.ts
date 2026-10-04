/** Read-only receipt/cost report from a closed, frozen optimized-run archive. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { PacketStore } from '../src/packet-store.js';
import { parseTransactionRequest } from '../src/durable-transaction-signer.js';
import { policyHash, relayProfileBody, verifyBudgetAudit } from '../src/relay-policy.js';
import { sizeGas } from '../src/gas.js';

const root='artifacts/monad-testnet/',archive='var/monad-testnet/optimized-run-evidence/';
const read=(name:string)=>JSON.parse(readFileSync(root+name,'utf8'));
const cfg=parseConfig(read('market-config.json')),d=cfg.destination!,abi=read('receiver-abi.json');
const policyRaw=read('small-run-policy.json'),policy=parseTestnetRunPolicy(policyRaw),plan=read('small-run-budget-plan.json');
const pilot=read('publication-pilot.json');
const rpcUrl=process.env.PRICEFEED_MONAD_RPC_URL;assert.ok(rpcUrl,'RPC environment required');
const rpc=monadSubmissionRpc(rpcUrl),client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{retryCount:0})});
const archiveSha256=Object.fromEntries(['source.sqlite','packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite']
  .map(name=>[name,createHash('sha256').update(readFileSync(archive+name)).digest('hex')]));
const relay=new DatabaseSync(archive+'relay.sqlite',{readOnly:true});
const transactions=new DatabaseSync(archive+'transactions.sqlite',{readOnly:true});
const source=new DatabaseSync(archive+'source.sqlite',{readOnly:true});
const packets=new PacketStore(archive+'packets.sqlite',true);
try{
  assert.equal(packets.verify(),true);
  const profile=relayProfileBody({chainId:10143n,...policy.budget},policy.relay);
  assert.equal(relay.prepare('SELECT profile FROM relay_control WHERE id=1').get()!.profile,profile);
  verifyBudgetAudit(relay,profile,policy.budget.budgetRevision);
  const audit=JSON.parse(String(relay.prepare('SELECT body FROM relay_budget_audit WHERE revision=1').get()!.body));
  assert.equal(audit.approvalHash,plan.approvalHash);
  const domain={chainId:10143n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  const inventory=packets.list(domain),rows=relay.prepare('SELECT body,sha256 FROM deliveries').all();
  const deliveries=rows.map(row=>{assert.equal(policyHash(String(row.body)),row.sha256);return JSON.parse(String(row.body));})
    .sort((a,b)=>Number(BigInt(a.nonce)-BigInt(b.nonce)));
  assert.ok(deliveries.length>3&&deliveries.length<=11,'no optimized finalized samples or count cap exceeded');
  assert.equal(transactions.prepare('SELECT count(*) AS count FROM transaction_reservations').get()!.count,deliveries.length);
  const checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi}),receipts=[],items=[];
  let totalCost=0n,optimizedCost=0n,reserved=0n,newReserved=0n;
  for(let i=0;i<deliveries.length;i++){
    const delivery=deliveries[i]!,saved=inventory.find(p=>p.packet.observation.sequence.toString()===delivery.sequence);
    assert.ok(saved?.signature);const packet=saved.packet,request=parseTransactionRequest(delivery.request);
    assert.equal(delivery.state,'FINALIZED');assert.equal(request.nonce,BigInt(i));
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
    if(i<3)assert.deepEqual(JSON.parse(json(item)),pilot.restartedRun.packets[i],'original pilot signed history changed');
    else{
      assert.ok(delivery.gasSizing);assert.equal(BigInt(delivery.gasSizing.marginBps),policy.relay.gasSafetyMarginBps);
      assert.equal(sizeGas(BigInt(delivery.gasSizing.estimatedGas),policy.relay.gasCap,policy.relay.gasSafetyMarginBps!).gasLimit,request.gas);
      assert.equal(BigInt(delivery.gasSizing.gasLimit),request.gas);newReserved+=reservation;
    }
    const receipt=await rpc.receipt(hash);assert.ok(receipt);assert.ok(receipt.blockNumber<=checkpoint.block.number);
    const block=await rpc.block({blockNumber:receipt.blockNumber});
    const accepted=validateReceipt(packet,hash,receipt,block,{depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad)});
    assert.equal(json(accepted),json(delivery.accepted));
    const full=await client.getTransactionReceipt({hash});assert.equal(full.blockHash,receipt.blockHash);assert.equal(full.status,'success');
    const cost=full.gasUsed*full.effectiveGasPrice;assert.ok(cost<=reservation);totalCost+=cost;if(i>=3)optimizedCost+=cost;
    receipts.push({nonce:i,sequence:packet.observation.sequence,receipt,gasLimit:request.gas,gasUsed:full.gasUsed,
      effectiveGasPrice:full.effectiveGasPrice,gasCostWei:cost,reservationWei:reservation,accepted});items.push(item);
  }
  assert.ok(reserved<=policy.budget.totalMaxCostWei&&newReserved<=BigInt(plan.additionalReservationWei));
  assert.ok(optimizedCost<=BigInt(plan.additionalReservationWei));
  const latest=items.at(-1)!.packet.observation;
  assert.equal(checkpoint.engine!.sourceState.lastSequence,latest.sequence);assert.equal(checkpoint.engine!.sourceState.lastObservedAt,latest.observedAt);
  assert.equal(await rpc.nonce(policy.sender as Hex),BigInt(deliveries.length));
  const captures=source.prepare('SELECT payload,sha256 FROM captures ORDER BY id').all().map(row=>{
    assert.equal(policyHash(String(row.payload)),row.sha256);return JSON.parse(String(row.payload));});
  const actual=await client.readContract({address:d.engineAddress as Hex,abi,functionName:'indexTwap300',
    args:[checkpoint.block.timestamp],blockNumber:checkpoint.block.number});
  assert.equal((await rpc.block({blockNumber:checkpoint.block.number})).hash,checkpoint.block.hash);
  for(const [name,checksum] of Object.entries(archiveSha256))assert.equal(createHash('sha256').update(readFileSync(archive+name)).digest('hex'),checksum,'archive changed');
  const report={mode:'MONAD_TESTNET_OPTIMIZED_GAS_DIAGNOSTIC',verifiedAtUtc:new Date().toISOString(),chainId:10143,
    config:cfg,sender:policy.sender,policy:policyRaw,approvedPlanHash:plan.approvalHash,archive,archiveSha256,captures,packets:items,receipts,checkpoint,
    transactionsFinalized:items.length,optimizedTransactionsFinalized:items.length-3,totalGasCostWei:totalCost,
    optimizedGasCostWei:optimizedCost,historicalReservationsWei:BigInt(plan.reservedWei),newReservationsWei:newReserved,
    previousSignedPacketsAndTransactionsUnchanged:true,twap:{evaluationBlock:checkpoint.block,actual},
    productionApproved:false,humanGatesAccepted:false,limitations:['Small gas-cost test; full sustained coverage and production cadence remain unproven.']};
  writeFileSync(root+'optimized-small-run.json',json(report)+'\n');
  console.log(json({verified:true,optimizedTransactionsFinalized:items.length-3,optimizedGasCostWei:optimizedCost,
    newReservationsWei:newReserved,twap:report.twap,productionApproved:false}));
}finally{packets.close();source.close();transactions.close();relay.close();}
