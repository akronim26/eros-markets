import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, stringToHex, isAddress, type Hex } from 'viem';
import { record } from './book.js';
import { uint, WAD } from './math.js';

export const OBSERVATION_TYPE='Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)';
export const TYPEHASH=keccak256(stringToHex(OBSERVATION_TYPE));
export const OBSERVATION_FIELDS=[['marketId','bytes32'],['sourceId','bytes32'],['sequence','uint64'],['observedAt','uint64'],['publishedAt','uint64'],['priceWad','uint256'],['impactBidWad','uint256'],['impactAskWad','uint256'],['bidDepthLots','uint256'],['askDepthLots','uint256'],['sourceRulesHash','bytes32']] as const;
export type Observation={marketId:string;sourceId:string;sequence:bigint;observedAt:bigint;publishedAt:bigint;priceWad:bigint;impactBidWad:bigint;impactAskWad:bigint;bidDepthLots:bigint;askDepthLots:bigint;sourceRulesHash:string};
export const INGRESS_ABI=[{type:'function',name:'submitObservation',stateMutability:'nonpayable',inputs:[{name:'obs',type:'tuple',components:OBSERVATION_FIELDS.map(([name,type])=>({name,type}))},{name:'signature',type:'bytes'}],outputs:[]}] as const;

export function parseObservation(value:unknown):Observation {
  const raw=record(value);
  if(Object.keys(raw).length!==11||Object.keys(raw).some(k=>!OBSERVATION_FIELDS.some(([name])=>name===k)))throw new Error('BAD_OBSERVATION_FIELDS');
  const output:Record<string,unknown>={};
  for(const [name,type] of OBSERVATION_FIELDS){const v=raw[name];
    if(type==='bytes32'){if(typeof v!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(v))throw new Error('BAD_BYTES32');output[name]=v;}
    else output[name]=uint(v,type==='uint64'?64:256);
  }
  const obs=output as Observation;
  if(obs.sequence===0n||obs.observedAt>obs.publishedAt||obs.priceWad>WAD||obs.impactBidWad>WAD||obs.impactAskWad>WAD)throw new Error('BAD_OBSERVATION_BOUNDS');
  return obs;
}

function validated(obs:Observation):Observation {
  return parseObservation(Object.fromEntries(Object.entries(obs).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v])));
}

export function observationDigest(obs:Observation,chainId:bigint,engine:string):Hex {
  const o=validated(obs);
  if(!isAddress(engine)||chainId<=0n||chainId>=(1n<<256n))throw new Error('BAD_SIGNATURE_DOMAIN');
  const parameters=parseAbiParameters('bytes32,bytes32,bytes32,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,bytes32,uint256,address');
  return keccak256(encodeAbiParameters(parameters,[TYPEHASH,o.marketId as Hex,o.sourceId as Hex,o.sequence,o.observedAt,o.publishedAt,o.priceWad,o.impactBidWad,o.impactAskWad,o.bidDepthLots,o.askDepthLots,o.sourceRulesHash as Hex,chainId,engine]));
}

// Encoding alone is not signing or sending. No wallet/RPC client is constructed.
export function submitCalldata(obs:Observation,signature:Hex):Hex {
  const o=validated(obs);
  if(!/^0x[0-9a-fA-F]{130}$/.test(signature))throw new Error('EXPECTED_65_BYTE_SIGNATURE');
  const tuple={...o,marketId:o.marketId as Hex,sourceId:o.sourceId as Hex,sourceRulesHash:o.sourceRulesHash as Hex};
  return encodeFunctionData({abi:INGRESS_ABI,functionName:'submitObservation',args:[tuple,signature]});
}
