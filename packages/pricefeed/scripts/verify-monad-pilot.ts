/** Read-only verification of the three-transaction pilot; never unlocks a key. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, http, keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { monadTestnet } from 'viem/chains';
import { parseConfig } from '../src/config.js';
import { json } from '../src/math.js';
import { observationDigest } from '../src/wire.js';
import { validateReceipt } from '../src/receipts.js';
import { monadSubmissionRpc } from '../src/monad-rpc.js';
import { preflightMonadTestnet } from '../src/monad-preflight.js';
import type { PreparedPacket } from '../src/packet-store.js';

const root='artifacts/monad-testnet/',archive='var/monad-testnet/pilot/';
function objects(path:string):Record<string,any>[] {
  // CLI emits pretty-printed objects. Each opening brace at column zero starts one record.
  return readFileSync(path,'utf8').trim().split(/\n(?=\{)/).map(s=>JSON.parse(s));
}
const first=objects('var/monad-pilot-first.jsonl').at(-1)!;
const restarted=objects('var/monad-pilot-restart.jsonl').at(-1)!;
assert.equal(first.finalizedPackets,2);assert.equal(restarted.finalizedPackets,3);
assert.equal(first.evidenceValid,true);assert.equal(restarted.evidenceValid,true);
assert.deepEqual(first.packets,restarted.packets.slice(0,2),'restart changed existing packet or signed transaction');
const config=parseConfig(JSON.parse(readFileSync(root+'market-config.json','utf8'))),d=config.destination!;
const abi=JSON.parse(readFileSync(root+'receiver-abi.json','utf8'));
const policy=JSON.parse(readFileSync(root+'publication-policy.json','utf8'));
const rpcUrl=process.env.PRICEFEED_MONAD_RPC_URL;assert.ok(rpcUrl,'RPC environment required');
const rpc=monadSubmissionRpc(rpcUrl),client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{retryCount:0})});
const checkpoint=await preflightMonadTestnet(rpc,{config,abi});
assert.equal(checkpoint.engine!.sourceState.lastSequence,3n);
const receipts=[];let cost=0n;
for(let i=0;i<restarted.packets.length;i++){
  const item=restarted.packets[i],p=item.packet;
  const packet:PreparedPacket={...p,sourceMs:BigInt(p.sourceMs),domain:{...p.domain,chainId:BigInt(p.domain.chainId)},
    observation:Object.fromEntries(Object.entries(p.observation).map(([k,v])=>[k,k.endsWith('Id')||k==='sourceRulesHash'?v:BigInt(String(v))])) as PreparedPacket['observation']};
  const delivery=item.delivery,hash=delivery.txHash as Hex,raw=delivery.raw as Hex;
  assert.equal(delivery.state,'FINALIZED');assert.equal(packet.observation.sequence,BigInt(i+1));
  assert.equal(BigInt(delivery.nonce),BigInt(i));
  assert.equal(observationDigest(packet.observation,10143n,d.engineAddress),item.digest);
  assert.equal((await recoverAddress({hash:item.digest,signature:item.signature})).toLowerCase(),d.signerAddress.toLowerCase());
  assert.equal(keccak256(raw),hash);
  assert.equal((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase(),policy.sender.toLowerCase());
  const tx=parseTransaction(raw);assert.equal(tx.chainId,10143);assert.equal(tx.nonce,i);
  assert.equal(tx.to!.toLowerCase(),d.engineAddress.toLowerCase());assert.equal(tx.value??0n,0n);
  const receipt=await rpc.receipt(hash);assert.ok(receipt);
  const block=await rpc.block({blockNumber:receipt.blockNumber});
  assert.ok(checkpoint.block.number>=block.number);
  const accepted=validateReceipt(packet,hash,receipt,block,{depthNLots:BigInt(config.pricing.depthNLots),maxSpreadWad:BigInt(config.pricing.maxSpreadWad)});
  assert.equal(accepted.depthValid,true);
  assert.equal(BigInt(delivery.accepted.acceptedAt),accepted.acceptedAt);
  const fullReceipt=await client.getTransactionReceipt({hash});
  const gasCost=fullReceipt.gasUsed*fullReceipt.effectiveGasPrice;
  assert.ok(gasCost<=BigInt(policy.relay.maxCostWei));cost+=gasCost;
  receipts.push({receipt,gasUsed:fullReceipt.gasUsed,effectiveGasPrice:fullReceipt.effectiveGasPrice,gasCostWei:gasCost,accepted});
}
assert.ok(cost<=BigInt(policy.budget.totalMaxCostWei));
assert.equal(checkpoint.engine!.sourceState.lastObservedAt,BigInt(restarted.packets.at(-1).packet.observation.observedAt));
const source=new DatabaseSync(archive+'source.sqlite',{readOnly:true});
const captures=source.prepare('SELECT payload,sha256 FROM captures ORDER BY id').all().map(row=>{
  const payload=String(row.payload);assert.equal(createHash('sha256').update(payload).digest('hex'),row.sha256);return JSON.parse(payload);
});source.close();
const archiveSha256=Object.fromEntries(['source.sqlite','packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite']
  .map(name=>[name,createHash('sha256').update(readFileSync(archive+name)).digest('hex')]));
const report={mode:'MONAD_TESTNET_DIAGNOSTIC_PUBLICATION',verifiedAtUtc:new Date().toISOString(),chainId:10143,
  config,sender:policy.sender,policy,archive,archiveSha256,firstRun:first,restartedRun:restarted,captures,checkpoint,receipts,
  restart:{newProcess:true,previousSignedPacketsAndTransactionsUnchanged:true,sequences:[1,2,3],nonces:[0,1,2]},
  totalGasCostWei:cost,transactionsFinalized:3,productionApproved:false,humanGatesAccepted:false,
  limitations:['Three-sample pilot does not establish full 300-second TWAP coverage or sustained availability.',
    'Diagnostic politics mapping and policies remain unapproved for production; no full economic engine is exercised.']};
writeFileSync(root+'publication-pilot.json',json(report)+'\n');
console.log(json({verified:true,transactionsFinalized:3,totalGasCostWei:cost,restart:report.restart}));
