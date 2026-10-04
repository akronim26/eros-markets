import { createPublicClient, http, keccak256, parseAbi, stringToHex, type Abi, type AbiParameter, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { record } from './book.js';
import { parseConfig, verifyListing, type MarketConfig } from './config.js';
import type { LifecycleCheckpoint } from './lifecycle.js';

export const MONAD_TESTNET_CHAIN_ID=10143;
// Full production tuple order matters: the short local demo listing is incompatible.
const READ_ABI=parseAbi([
  'function listing() view returns ((bytes32 marketId,address token,address registry,address resolutionAuthority,address monitor,address governance,uint64 scheduledT,uint64 listedAt,bytes32 sourceHash,bytes32 rulesHash,(bool fallbackListed,uint64 captureGraceSecs,uint256 fallbackPriceWad,uint64 voidSecs) invalidRule,uint8 template,uint256 deploymentCapX,uint32 maxTraders,bytes32 indexSourceId,address indexSigner,bytes32 indexRulesHash,uint256 depthNLots,uint256 maxSpreadWad,uint256 bootstrapBandWad,uint64 minOrderLots,uint64 maxOrderLots,uint64 maxLiqLotsPerBlock,bool fundingEnabled))',
  'function sourceState(bytes32) view returns ((address signer,bytes32 rulesHash,uint64 lastSequence,uint64 lastObservedAt,bool configured))',
  'function halted() view returns (bool)',
]);
type EngineRead='listing'|'sourceState'|'halted';
export type MonadBlock={number:bigint;hash:Hex;timestamp:bigint};
/** This interface has no signing, wallet, nonce allocation or sending methods. */
export interface MonadReadRpc {
  chainId():Promise<number>;
  block(selector:{blockTag:'finalized'}|{blockNumber:bigint}):Promise<MonadBlock>;
  code(address:Hex,blockNumber:bigint):Promise<Hex|undefined>;
  read(address:Hex,abi:Abi,name:EngineRead,sourceId:Hex,blockNumber:bigint):Promise<unknown>;
}
const hash=(value:unknown):value is Hex=>typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value);
const address=(value:unknown):value is Hex=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value);
const uint64=(value:unknown):value is bigint=>typeof value==='bigint'&&value>=0n&&value<(1n<<64n);
async function rpcCall<T>(code:string,call:()=>Promise<T>):Promise<T> {
  try{return await call();}catch{throw new Error(code);}
}

/** HTTPS only. RPC credentials are never included in returned state or errors. */
export function monadTestnetReadRpc(rpcUrl:string):MonadReadRpc {
  let url:URL;try{url=new URL(rpcUrl);}catch{throw new Error('MONAD_BAD_RPC_URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('MONAD_HTTPS_RPC_REQUIRED');
  if(monadTestnet.id!==MONAD_TESTNET_CHAIN_ID)throw new Error('MONAD_CHAIN_DEFINITION_MISMATCH');
  const client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{timeout:5000,retryCount:0,fetchOptions:{redirect:'error'}})});
  return {
    chainId:()=>client.getChainId(),
    block:async(selector)=>{const b=await client.getBlock(selector);return {number:b.number,hash:b.hash,timestamp:b.timestamp};},
    code:(engine,blockNumber)=>client.getBytecode({address:engine,blockNumber}),
    read:(engine,abi,name,sourceId,blockNumber)=>client.readContract({address:engine,abi,functionName:name,
      ...(name==='sourceState'?{args:[sourceId]}:{}),blockNumber}),
  };
}

function parameterShape(p:AbiParameter,named:boolean):unknown {
  return {type:p.type,...(named?{name:p.name??''}:{}),
    ...('components' in p?{components:p.components.map(c=>parameterShape(c,true))}:{})};
}
export function parseEngineReadAbi(value:unknown):{abi:Abi;abiHash:Hex} {
  const raw=Array.isArray(value)?value:record(value).abi;
  if(!Array.isArray(raw))throw new Error('MONAD_ENGINE_ABI_REQUIRED');
  const abi=JSON.parse(JSON.stringify(raw)) as Abi;
  for(const expected of READ_ABI){
    if(expected.type!=='function')continue;
    const matches=abi.filter(item=>item.type==='function'&&item.name===expected.name);
    const fn=matches[0];
    if(matches.length!==1||!fn||fn.type!=='function'||fn.stateMutability!=='view'
      ||!Array.isArray(fn.inputs)||!Array.isArray(fn.outputs)
      ||JSON.stringify(fn.inputs.map(p=>parameterShape(p,false)))!==JSON.stringify(expected.inputs.map(p=>parameterShape(p,false)))
      ||JSON.stringify(fn.outputs.map(p=>parameterShape(p,false)))!==JSON.stringify(expected.outputs.map(p=>parameterShape(p,false))))
      throw new Error('MONAD_ENGINE_READ_ABI_MISMATCH');
  }
  return {abi,abiHash:keccak256(stringToHex(JSON.stringify(abi)))};
}

export type MonadPreflightResult={
  mode:'MONAD_TESTNET_READ_ONLY';status:'NETWORK_VERIFIED_ENGINE_NOT_CONFIGURED'|'ENGINE_PINS_VERIFIED';
  chainId:bigint;blockTag:'finalized';block:MonadBlock;checkedAtMs:bigint;
  engine:null|{address:string;engineCodeHash:Hex;abiHash:Hex;listing:Record<string,unknown>;
    sourceState:{signer:Hex;rulesHash:Hex;lastSequence:bigint;lastObservedAt:bigint;configured:true};
    lifecycle:LifecycleCheckpoint};
  operationalOutput:false;signaturesProduced:0;transactionsSent:0;
};

/** One-shot evidence, not permission to publish or a persistent lifecycle controller.
 * No fallback from finalized or named-block reads to speculative latest state.
 */
export async function preflightMonadTestnet(rpc:MonadReadRpc,
  engine?:{config:MarketConfig;abi:unknown},now:()=>bigint=()=>BigInt(Date.now())):Promise<MonadPreflightResult> {
  // Freeze caller inputs before the first await; unpinned discovery cannot bless an engine.
  const cfg=engine?parseConfig(structuredClone(engine.config)):null;
  if(cfg&&(cfg.enabled||!cfg.destination||cfg.destination.chainId!==String(MONAD_TESTNET_CHAIN_ID)))
    throw new Error('MONAD_DISABLED_TESTNET_CONFIG_REQUIRED');
  const parsed=engine?parseEngineReadAbi(engine.abi):null,d=cfg?.destination;
  if(parsed&&d&&parsed.abiHash.toLowerCase()!==d.abiHash.toLowerCase())throw new Error('MONAD_ABI_PIN_MISMATCH');
  const checkChain=async()=>{
    if(await rpcCall('MONAD_RPC_CHAIN_FAILED',()=>rpc.chainId())!==MONAD_TESTNET_CHAIN_ID)throw new Error('MONAD_WRONG_CHAIN');
  };
  const checkBlock=(b:MonadBlock)=>{
    if(typeof b.number!=='bigint'||b.number<0n||!hash(b.hash)||typeof b.timestamp!=='bigint'||b.timestamp<0n)
      throw new Error('MONAD_BAD_BLOCK');
    const age=now()-b.timestamp*1000n;
    // A diagnostic guard only; production checkpoint/delivery budgets remain Q07/Q09.
    if(age<0n||age>30000n)throw new Error('MONAD_STALE_OR_FUTURE_BLOCK');
  };
  await checkChain();
  const block=await rpcCall('MONAD_FINALIZED_BLOCK_FAILED',()=>rpc.block({blockTag:'finalized'}));checkBlock(block);
  let verified:MonadPreflightResult['engine']=null;
  if(cfg&&d&&parsed){
    const engineAddress=d.engineAddress as Hex,sourceId=d.sourceId as Hex;
    const code=await rpcCall('MONAD_CODE_READ_FAILED',()=>rpc.code(engineAddress,block.number));
    if(!code||!/^0x(?:[0-9a-fA-F]{2})+$/.test(code))throw new Error('MONAD_ENGINE_CODE_MISSING');
    const engineCodeHash=keccak256(code);
    if(engineCodeHash.toLowerCase()!==d.engineCodeHash.toLowerCase())throw new Error('MONAD_CODE_PIN_MISMATCH');
    const [listingRaw,stateRaw,halted]=await Promise.all([
      rpcCall('MONAD_LISTING_READ_FAILED',()=>rpc.read(engineAddress,parsed.abi,'listing',sourceId,block.number)),
      rpcCall('MONAD_SOURCE_READ_FAILED',()=>rpc.read(engineAddress,parsed.abi,'sourceState',sourceId,block.number)),
      rpcCall('MONAD_HALT_READ_FAILED',()=>rpc.read(engineAddress,parsed.abi,'halted',sourceId,block.number)),
    ]);
    let listing:Record<string,unknown>;try{listing=record(listingRaw);verifyListing(cfg,listing);}catch{throw new Error('MONAD_LISTING_PIN_MISMATCH');}
    let state:Record<string,unknown>;try{state=record(stateRaw);}catch{throw new Error('MONAD_BAD_SOURCE_STATE');}
    if(!address(state.signer)||!hash(state.rulesHash)||!uint64(state.lastSequence)||!uint64(state.lastObservedAt)
      ||typeof state.configured!=='boolean')throw new Error('MONAD_BAD_SOURCE_STATE');
    if(!state.configured)throw new Error('MONAD_SOURCE_NOT_CONFIGURED');
    if(state.signer.toLowerCase()!==d.signerAddress.toLowerCase()||state.rulesHash.toLowerCase()!==d.sourceRulesHash.toLowerCase())
      throw new Error('MONAD_SOURCE_PIN_MISMATCH');
    if(state.lastObservedAt>block.timestamp||(state.lastSequence===0n&&state.lastObservedAt!==0n))throw new Error('MONAD_SOURCE_STATE_CONTRADICTION');
    if(typeof halted!=='boolean')throw new Error('MONAD_BAD_HALT_STATE');
    verified={address:d.engineAddress,engineCodeHash,abiHash:parsed.abiHash,listing,
      sourceState:{signer:state.signer,rulesHash:state.rulesHash,lastSequence:state.lastSequence,lastObservedAt:state.lastObservedAt,configured:true},
      lifecycle:{chainId:BigInt(MONAD_TESTNET_CHAIN_ID),engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,
        engineCodeHash,rulesHash:state.rulesHash,scheduledT:BigInt(d.scheduledT),halted,
        blockNumber:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,canonical:true}};
  }
  // Both reads follow all contract reads. Await both, retaining deterministic
  // error priority, but do not spend an extra network round trip on chain ID.
  const [canonicalRead,chainRead]=await Promise.allSettled([
    rpcCall('MONAD_CANONICAL_BLOCK_FAILED',()=>rpc.block({blockNumber:block.number})),checkChain(),
  ]);
  if(canonicalRead.status==='rejected')throw canonicalRead.reason;
  const canonical=canonicalRead.value;checkBlock(canonical);
  if(canonical.number!==block.number||canonical.hash.toLowerCase()!==block.hash.toLowerCase()||canonical.timestamp!==block.timestamp)
    throw new Error('MONAD_BLOCK_CHANGED');
  if(chainRead.status==='rejected')throw chainRead.reason;
  checkBlock(block);
  return {mode:'MONAD_TESTNET_READ_ONLY',status:verified?'ENGINE_PINS_VERIFIED':'NETWORK_VERIFIED_ENGINE_NOT_CONFIGURED',
    chainId:BigInt(MONAD_TESTNET_CHAIN_ID),blockTag:'finalized',block,checkedAtMs:now(),engine:verified,
    operationalOutput:false,signaturesProduced:0,transactionsSent:0};
}
