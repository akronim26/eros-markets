import { createPublicClient, http, TransactionReceiptNotFoundError, BlockNotFoundError, parseTransaction,
  recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { monadTestnet } from 'viem/chains';
import { parseConfig, type MarketConfig } from './config.js';
import type { LocalRelayTransport, RelayPolicy } from './durable-relay.js';
import type { DeliveryReceipt } from './receipts.js';
import type { MonadTestnetTransactionSigner } from './monad-signers.js';
import { monadTestnetReadRpc, parseEngineReadAbi, preflightMonadTestnet, type MonadReadRpc } from './monad-preflight.js';

export interface MonadSubmissionRpc extends MonadReadRpc {
  nonce(sender:Hex):Promise<bigint>;
  balance(sender:Hex):Promise<bigint>;
  simulate(sender:Hex,to:Hex,data:Hex,gasCap:bigint):Promise<void>;
  send(raw:Hex):Promise<Hex>;
  receipt(hash:Hex):Promise<DeliveryReceipt|null>;
}
/** HTTPS testnet I/O. No wallet client, fallback block tag or automatic RPC retry. */
export function monadSubmissionRpc(rpcUrl:string):MonadSubmissionRpc {
  const read=monadTestnetReadRpc(rpcUrl);
  const client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{timeout:5000,retryCount:0,fetchOptions:{redirect:'error'}})});
  return {...read,
    nonce:async(sender)=>BigInt(await client.getTransactionCount({address:sender,blockTag:'pending'})),
    balance:(sender)=>client.getBalance({address:sender,blockTag:'pending'}),
    simulate:async(sender,to,data,gasCap)=>{
      await client.call({account:sender,to,data,gas:gasCap,blockTag:'pending'});
      if(await client.estimateGas({account:sender,to,data,blockTag:'pending'})>gasCap)throw new Error('MONAD_GAS_CAP_EXCEEDED');
    },
    send:(raw)=>client.sendRawTransaction({serializedTransaction:raw}),
    receipt:async(hash)=>{
      try{
        const r=await client.getTransactionReceipt({hash});
        return {status:r.status,transactionHash:r.transactionHash,blockNumber:r.blockNumber,blockHash:r.blockHash,
          logs:r.logs.map(l=>{
            if(l.transactionHash===null||l.blockNumber===null||l.blockHash===null||l.logIndex===null)throw new Error('MONAD_INCOMPLETE_RECEIPT');
            return {address:l.address,data:l.data,topics:l.topics,transactionHash:l.transactionHash,blockNumber:l.blockNumber,
              blockHash:l.blockHash,logIndex:l.logIndex,removed:l.removed};
          })};
      }catch(error){if(error instanceof TransactionReceiptNotFoundError)return null;throw error;}
    },
  };
}
async function fixed<T>(reason:string,operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch{throw new Error(reason);}
}
/** Concrete fixed-chain adapter; the relay's head is finalized, never latest. */
export function monadRpcTransport(rpcUrl:string,config:MarketConfig,engineAbi:unknown,
  signer:MonadTestnetTransactionSigner,policy:RelayPolicy,rpc:MonadSubmissionRpc=monadSubmissionRpc(rpcUrl),
  now:()=>bigint=()=>BigInt(Date.now())):LocalRelayTransport {
  const url=new URL(rpcUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('MONAD_HTTPS_RPC_REQUIRED');
  const cfg=parseConfig(structuredClone(config)),d=cfg.destination,parsed=parseEngineReadAbi(engineAbi);
  policy={...policy};
  if(cfg.enabled||!d||d.chainId!=='10143'||parsed.abiHash.toLowerCase()!==d.abiHash.toLowerCase())throw new Error('MONAD_CONFIG_OR_ABI_MISMATCH');
  const account=signer.address as Hex;
  const check=async()=>{if(await fixed('MONAD_RPC_CHAIN_FAILED',()=>rpc.chainId())!==10143)throw new Error('MONAD_WRONG_CHAIN');};
  const destination=(to:string)=>{if(to.toLowerCase()!==d.engineAddress.toLowerCase())throw new Error('MONAD_RECEIVER_MISMATCH');};
  return {rpcUrl,sender:account,transactionJournal:signer,finalizedHead:true,
    pendingNonce:async()=>{await check();return fixed('MONAD_NONCE_READ_FAILED',()=>rpc.nonce(account));},
    identity:async(domain)=>{
      if(domain.chainId!==10143n||domain.engine.toLowerCase()!==d.engineAddress.toLowerCase()
        ||domain.marketId.toLowerCase()!==d.marketId.toLowerCase()||domain.sourceId.toLowerCase()!==d.sourceId.toLowerCase()
        ||domain.signer.toLowerCase()!==d.signerAddress.toLowerCase()||domain.rulesHash.toLowerCase()!==d.sourceRulesHash.toLowerCase())
        throw new Error('MONAD_DOMAIN_MISMATCH');
      const result=await preflightMonadTestnet(rpc,{config:cfg,abi:parsed.abi},now),engine=result.engine;
      if(!engine)throw new Error('MONAD_ENGINE_REQUIRED');
      return {chainId:10143n,engineCodeHash:engine.engineCodeHash,abiHash:engine.abiHash,listing:engine.listing,
        signer:engine.sourceState.signer,rulesHash:engine.sourceState.rulesHash,
        lastSequence:engine.sourceState.lastSequence,lastObservedAt:engine.sourceState.lastObservedAt};
    },
    simulate:async(to,data)=>{
      destination(to);await check();
      if(await fixed('MONAD_BALANCE_READ_FAILED',()=>rpc.balance(account))<policy.maxCostWei)throw new Error('MONAD_SENDER_NEEDS_TEST_MON');
      await fixed('MONAD_SIMULATION_FAILED',()=>rpc.simulate(account,to as Hex,data,policy.gasCap));
    },
    prepare:async(request)=>{destination(request.to);await check();return signer.sign(request);},
    broadcast:async(raw)=>{
      await check();
      const tx=parseTransaction(raw);
      if(tx.chainId!==10143||!tx.to||tx.type!=='eip1559'||(tx.value??0n)!==0n||!tx.gas
        ||tx.gas>policy.gasCap||!tx.maxFeePerGas||tx.maxFeePerGas>policy.maxFeePerGas
        ||tx.gas*tx.maxFeePerGas>policy.maxCostWei||tx.maxPriorityFeePerGas===undefined
        ||tx.maxPriorityFeePerGas>policy.maxPriorityFeePerGas)throw new Error('MONAD_TRANSACTION_MISMATCH');
      destination(tx.to);
      if((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase()!==account.toLowerCase())
        throw new Error('MONAD_TRANSACTION_MISMATCH');
      return fixed('MONAD_BROADCAST_RESULT_UNKNOWN',()=>rpc.send(raw));
    },
    receipt:async(hash)=>{await check();return fixed('MONAD_RECEIPT_READ_FAILED',()=>rpc.receipt(hash));},
    block:async(number)=>{
      await check();
      try{return await rpc.block({blockNumber:number});}catch(error){if(error instanceof BlockNotFoundError)return null;throw new Error('MONAD_BLOCK_READ_FAILED');}
    },
    head:async()=>{
      await check();const b=await fixed('MONAD_FINALIZED_BLOCK_FAILED',()=>rpc.block({blockTag:'finalized'}));
      const age=now()-b.timestamp*1000n;
      if(age<0n||age>30000n)throw new Error('MONAD_STALE_OR_FUTURE_BLOCK');
      return b.number;
    },
  };
}
