import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';
import { record } from './book.js';
import { uint, WAD } from './math.js';

export const PRICING_POLICY='before-fee-vwap-bid-floor-ask-ceil-mid-floor-depth-total-floor-v1';
export const RULES_DOMAIN=keccak256(stringToHex('EROS_POLYMARKET_INDEX_RULES_V1'));
// Candidate v1 schema. These bytes do not constitute factory/risk approval.
export const RULES_FIELDS=[['schemaVersion','uint64'],['venue','bytes32'],['marketId','bytes32'],['sourceId','bytes32'],
  ['eventId','uint256'],['externalMarketId','uint256'],['conditionId','bytes32'],['outcomeTokenId','uint256'],
  ['outcomeLabel','bytes32'],['erosRulesHash','bytes32'],['externalRulesDigest','bytes32'],['quotePolicyHash','bytes32'],
  ['quantityPolicyHash','bytes32'],['timestampPolicyHash','bytes32'],['failurePolicyHash','bytes32'],
  ['scheduledT','uint64'],['depthNLots','uint256'],['maxSpreadWad','uint256'],['pricingPolicy','bytes32']] as const;
export type RulesManifest={schemaVersion:'1';venue:'polymarket';marketId:string;sourceId:string;eventId:string;
  externalMarketId:string;conditionId:string;outcomeTokenId:string;outcomeLabel:string;erosRulesHash:string;
  externalRulesDigest:string;quotePolicyHash:string;quantityPolicyHash:string;timestampPolicyHash:string;
  failurePolicyHash:string;scheduledT:string;depthNLots:string;maxSpreadWad:string;pricingPolicy:typeof PRICING_POLICY};

export function parseRules(value:unknown):RulesManifest {
  const raw=record(value);
  if(Object.keys(raw).length!==RULES_FIELDS.length||Object.keys(raw).some(k=>!RULES_FIELDS.some(([name])=>name===k)))throw new Error('BAD_RULES_FIELDS');
  if(raw.schemaVersion!=='1'||raw.venue!=='polymarket'||raw.pricingPolicy!==PRICING_POLICY)throw new Error('UNSUPPORTED_RULES_POLICY');
  for(const [name,type] of RULES_FIELDS){
    if(['venue','outcomeLabel','pricingPolicy'].includes(name)){
      if(typeof raw[name]!=='string'||String(raw[name]).length===0||String(raw[name]).length>500)throw new Error('BAD_RULES_TEXT');
    }else if(type==='bytes32'){
      if(typeof raw[name]!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(String(raw[name]))||/^0x0{64}$/i.test(String(raw[name])))throw new Error('BAD_RULES_HASH');
    }else uint(raw[name],type==='uint64'?64:256);
  }
  if(BigInt(String(raw.depthNLots))===0n||BigInt(String(raw.maxSpreadWad))>WAD)throw new Error('BAD_RULES_DEPTH');
  return Object.fromEntries(RULES_FIELDS.map(([name])=>[name,raw[name]])) as RulesManifest;
}

export function encodeRules(value:RulesManifest):Hex {
  const manifest=parseRules(value);
  const values=RULES_FIELDS.map(([name,type])=>type!=='bytes32'?BigInt(manifest[name])
    :['venue','outcomeLabel','pricingPolicy'].includes(name)?keccak256(stringToHex(manifest[name])):manifest[name] as Hex);
  return encodeAbiParameters([{type:'bytes32'},...RULES_FIELDS.map(([,type])=>({type}))],[RULES_DOMAIN,...values]);
}
export function rulesHash(value:RulesManifest):Hex {return keccak256(encodeRules(value));}
