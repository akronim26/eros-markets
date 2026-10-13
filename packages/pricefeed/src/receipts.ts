import { decodeEventLog, parseAbi, type Hex } from 'viem';
import { observationDigest } from './wire.js';
import type { PreparedPacket } from './packet-store.js';

export const ACCEPTED_ABI=parseAbi(['event ObservationAccepted(bytes32 indexed sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint64 acceptedAt,uint256 priceWad,bool depthValid,bytes32 payloadDigest)']);
export type ReceiptLog={address:string;data:Hex;topics:readonly Hex[];transactionHash:Hex;blockNumber:bigint;
  blockHash:Hex;logIndex:number;removed:boolean};
export type DeliveryReceipt={status:'success'|'reverted';transactionHash:Hex;blockNumber:bigint;blockHash:Hex;logs:readonly ReceiptLog[]};
export type AcceptedReceipt={transactionHash:Hex;blockNumber:bigint;blockHash:Hex;logIndex:number;acceptedAt:bigint;
  digest:Hex;depthValid:boolean;priceWad:bigint;state:'MINED'};
export function validateReceipt(packet:PreparedPacket,expectedTx:Hex,receipt:DeliveryReceipt,
  block:{number:bigint;hash:Hex;timestamp:bigint},depthRule:{depthNLots:bigint;maxSpreadWad:bigint}):AcceptedReceipt {
  const hex32=(v:string)=>/^0x[0-9a-fA-F]{64}$/.test(v);
  if(!hex32(expectedTx)||!hex32(block.hash)||receipt.transactionHash.toLowerCase()!==expectedTx.toLowerCase()
    ||receipt.blockNumber!==block.number||receipt.blockHash.toLowerCase()!==block.hash.toLowerCase()
    ||block.number<0n||block.timestamp<0n||block.timestamp>=(1n<<64n))throw new Error('RECEIPT_IDENTITY_MISMATCH');
  if(receipt.status!=='success')throw new Error('TRANSACTION_REVERTED');
  const obs=packet.observation,digest=observationDigest(obs,packet.domain.chainId,packet.domain.engine);
  const expectedDepth=obs.bidDepthLots>=depthRule.depthNLots&&obs.askDepthLots>=depthRule.depthNLots
    &&obs.impactBidWad>0n&&obs.impactBidWad<=obs.impactAskWad&&obs.impactAskWad<10n**18n
    &&obs.impactAskWad-obs.impactBidWad<=depthRule.maxSpreadWad;
  if(depthRule.depthNLots<=0n||depthRule.maxSpreadWad<0n||depthRule.maxSpreadWad>10n**18n)throw new Error('BAD_RECEIPT_DEPTH_RULE');
  const mid=expectedDepth?(obs.impactBidWad+obs.impactAskWad)/2n:0n;
  if(expectedDepth&&obs.priceWad!==mid)throw new Error('SIGNED_MIDPOINT_MISMATCH');
  const matches:AcceptedReceipt[]=[];
  for(const log of receipt.logs){
    if(log.address.toLowerCase()!==packet.domain.engine.toLowerCase())continue;
    let decoded;
    try{decoded=decodeEventLog({abi:ACCEPTED_ABI,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});}
    catch{continue;}
    const a=decoded.args;
    if(a.sourceId.toLowerCase()!==obs.sourceId.toLowerCase()||a.sequence!==obs.sequence)continue;
    if(log.removed||log.transactionHash.toLowerCase()!==expectedTx.toLowerCase()||log.blockNumber!==block.number
      ||log.blockHash.toLowerCase()!==block.hash.toLowerCase()||!Number.isSafeInteger(log.logIndex)||log.logIndex<0
      ||a.observedAt!==obs.observedAt||a.publishedAt!==obs.publishedAt||a.acceptedAt!==block.timestamp
      ||a.publishedAt>a.acceptedAt||a.payloadDigest!==digest||a.depthValid!==expectedDepth||a.priceWad!==mid)throw new Error('ACCEPTED_LOG_MISMATCH');
    matches.push({transactionHash:receipt.transactionHash,blockNumber:block.number,blockHash:block.hash,logIndex:log.logIndex,
      acceptedAt:a.acceptedAt,digest,depthValid:a.depthValid,priceWad:a.priceWad,state:'MINED'});
  }
  if(matches.length!==1)throw new Error('EXPECTED_EXACTLY_ONE_ACCEPTED_LOG');
  return matches[0]!;
}
export function confirmationState(record:AcceptedReceipt,canonicalHash:Hex|null,head:bigint,requiredConfirmations:bigint):'MINED'|'FINALIZED'|'ORPHANED' {
  if(requiredConfirmations<=0n||head<0n)throw new Error('BAD_FINALITY_POLICY');
  if(canonicalHash!==null&&!/^0x[0-9a-fA-F]{64}$/.test(canonicalHash))throw new Error('BAD_CANONICAL_BLOCK_HASH');
  if(canonicalHash===null||head<record.blockNumber)return 'MINED'; // unknown RPC data cannot assert an orphan or finality.
  if(canonicalHash.toLowerCase()!==record.blockHash.toLowerCase())return 'ORPHANED';
  return head-record.blockNumber+1n>=requiredConfirmations?'FINALIZED':'MINED';
}
