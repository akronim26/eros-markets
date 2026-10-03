import { createPublicClient, defineChain, http, keccak256, parseAbi, stringToHex, type Abi, type Hex,
  TransactionReceiptNotFoundError, BlockNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { record } from './book.js';
import type { LocalRelayTransport } from './local-relay.js';

const SOURCE_ABI=parseAbi(['function sourceState(bytes32) view returns ((address signer,bytes32 rulesHash,uint64 lastSequence,uint64 lastObservedAt,bool configured))']);
/** Concrete development adapter. Only a public fixture account and loopback chain 31337. */
export function localRpcTransport(rpcUrl:string,engineAbi:Abi):LocalRelayTransport {
  const url=new URL(rpcUrl);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.hash)throw new Error('LOCAL_RPC_ONLY');
  if(!engineAbi.some(item=>item.type==='function'&&item.name==='listing'))throw new Error('LOCAL_LISTING_ABI_REQUIRED');
  const abi=JSON.parse(JSON.stringify(engineAbi)) as Abi,abiHash=keccak256(stringToHex(JSON.stringify(abi)));
  const chain=defineChain({id:31337,name:'Owned pricefeed development chain',nativeCurrency:{name:'Test Ether',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});
  const client=createPublicClient({chain,transport:http(rpcUrl,{timeout:5000,retryCount:0,fetchOptions:{redirect:'error'}})});
  const account=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
  const check=async()=>{if(await client.getChainId()!==31337)throw new Error('DEVELOPMENT_CHAIN_ONLY');};
  return {rpcUrl,sender:account.address,
    pendingNonce:async()=>{await check();return BigInt(await client.getTransactionCount({address:account.address,blockTag:'pending'}));},
    identity:async(domain)=>{
      await check();if(domain.chainId!==31337n)throw new Error('DEVELOPMENT_CHAIN_ONLY');
      const block=await client.getBlock({blockTag:'latest'}),address=domain.engine as Hex;
      const [code,listing,state]=await Promise.all([
        client.getBytecode({address,blockNumber:block.number}),
        client.readContract({address,abi,functionName:'listing',blockNumber:block.number}),
        client.readContract({address,abi:SOURCE_ABI,functionName:'sourceState',args:[domain.sourceId as Hex],blockNumber:block.number}),
      ]);
      if(!code||code==='0x'||!state.configured)throw new Error('LOCAL_ENGINE_OR_SOURCE_MISSING');
      const canonical=await client.getBlock({blockNumber:block.number});
      if(canonical.hash!==block.hash)throw new Error('PREFLIGHT_BLOCK_CHANGED');
      return {chainId:31337n,engineCodeHash:keccak256(code),abiHash,listing:record(listing),
        signer:state.signer,rulesHash:state.rulesHash,lastSequence:state.lastSequence,lastObservedAt:state.lastObservedAt};
    },
    // Simulate inclusion in the next block; a quiet local chain's latest timestamp
    // can predate an authentic packet. The mined engine still enforces zero future tolerance.
    simulate:async(to,data)=>{await check();await client.call({account:account.address,to:to as Hex,data,blockTag:'pending'});},
    prepare:async(req)=>{await check();if(req.nonce<0n||req.nonce>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('BAD_RELAY_NONCE');
      return account.signTransaction({type:'eip1559',chainId:31337,to:req.to as Hex,data:req.data,nonce:Number(req.nonce),
        gas:req.gas,maxFeePerGas:req.maxFeePerGas,maxPriorityFeePerGas:req.maxPriorityFeePerGas,value:0n});},
    broadcast:async(raw)=>{await check();return client.sendRawTransaction({serializedTransaction:raw});},
    receipt:async(hash)=>{
      await check();
      try{const r=await client.getTransactionReceipt({hash});return {status:r.status,transactionHash:r.transactionHash,
        blockNumber:r.blockNumber,blockHash:r.blockHash,logs:r.logs.map(l=>{
          if(l.transactionHash===null||l.blockNumber===null||l.blockHash===null||l.logIndex===null)throw new Error('INCOMPLETE_RECEIPT_LOG');
          return {address:l.address,data:l.data,topics:l.topics,transactionHash:l.transactionHash,blockNumber:l.blockNumber,
            blockHash:l.blockHash,logIndex:l.logIndex,removed:l.removed};})};
      }catch(error){if(error instanceof TransactionReceiptNotFoundError)return null;throw error;}
    },
    block:async(number)=>{await check();try{const b=await client.getBlock({blockNumber:number});return {number:b.number,hash:b.hash,timestamp:b.timestamp};}
      catch(error){if(error instanceof BlockNotFoundError)return null;throw error;}},
    head:async()=>{await check();return client.getBlockNumber({cacheTime:0});},
  };
}
