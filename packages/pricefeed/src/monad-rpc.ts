import { createPublicClient, http, TransactionReceiptNotFoundError, BlockNotFoundError, parseTransaction,
  recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { monadTestnet } from 'viem/chains';
import { parseConfig, type MarketConfig } from './config.js';
import type { LocalRelayTransport, RelayPolicy } from './durable-relay.js';
import type { DeliveryReceipt } from './receipts.js';
import type { MonadTestnetTransactionSigner } from './monad-signers.js';
import { monadReadTransport, monadTestnetReadRpc, parseEngineReadAbi, preflightMonadTestnet, type MonadReadRpc } from './monad-preflight.js';
import { sizeGas } from './gas.js';

export interface MonadSubmissionRpc extends MonadReadRpc {
  nonce(sender:Hex):Promise<bigint>;
  balance(sender:Hex):Promise<bigint>;
  simulate(sender:Hex,to:Hex,data:Hex,gasCap:bigint):Promise<bigint|void>;
  send(raw:Hex):Promise<Hex>;
  receipt(hash:Hex):Promise<DeliveryReceipt|null>;
}
/** HTTPS testnet I/O. Reads may retry once; signed broadcasts never auto-retry. */
export function monadSubmissionRpc(rpcUrl:string):MonadSubmissionRpc {
  const read=monadTestnetReadRpc(rpcUrl);
  const client=createPublicClient({chain:monadTestnet,transport:http(rpcUrl,{timeout:5000,retryCount:0,fetchOptions:{redirect:'error'}})});
  const reads=createPublicClient({chain:monadTestnet,transport:monadReadTransport(rpcUrl)});
  let writerCheckedAt=0,writerCheck:Promise<void>|undefined;
  const checkWriter=async()=>{
    if(Date.now()-writerCheckedAt<5000)return;
    writerCheck??=client.getChainId().then(chain=>{
      if(chain!==10143)throw new Error('MONAD_WRITER_WRONG_CHAIN');writerCheckedAt=Date.now();
    }).finally(()=>{writerCheck=undefined;});
    await writerCheck;
  };
  return {...read,
    nonce:async(sender)=>{await checkWriter();return BigInt(await client.getTransactionCount({address:sender,blockTag:'pending'}));},
    balance:async(sender)=>{await checkWriter();return client.getBalance({address:sender,blockTag:'pending'});},
    simulate:async(sender,to,data,gasCap)=>{
      await checkWriter();
      const [,estimate]=await Promise.all([
        client.call({account:sender,to,data,gas:gasCap,blockTag:'pending'}),
        client.estimateGas({account:sender,to,data,gas:gasCap,blockTag:'pending'}),
      ]);
      if(estimate>gasCap)throw new Error('MONAD_GAS_CAP_EXCEEDED');return estimate;
    },
    send:async(raw)=>{await checkWriter();return client.sendRawTransaction({serializedTransaction:raw});},
    receipt:async(hash)=>{
      try{
        const r=await reads.getTransactionReceipt({hash});
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
    pendingNonce:async()=>{const [,nonce]=await Promise.all([check(),fixed('MONAD_NONCE_READ_FAILED',()=>rpc.nonce(account))]);return nonce;},
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
    simulate:async(to,data,reservedGas)=>{
      destination(to);
      const [,balance]=await Promise.all([check(),fixed('MONAD_BALANCE_READ_FAILED',()=>rpc.balance(account))]);
      if(balance<policy.maxCostWei)throw new Error('MONAD_SENDER_NEEDS_TEST_MON');
      if(reservedGas!==undefined&&(reservedGas<21000n||reservedGas>policy.gasCap))throw new Error('MONAD_GAS_CAP_EXCEEDED');
      const estimate=await fixed('MONAD_SIMULATION_FAILED',()=>rpc.simulate(account,to as Hex,data,reservedGas??policy.gasCap));
      if(policy.gasSafetyMarginBps===undefined)return;
      if(reservedGas!==undefined){
        if(typeof estimate!=='bigint'||estimate<21000n)throw new Error('MONAD_GAS_ESTIMATE_REQUIRED');
        if(estimate>reservedGas)throw new Error('MONAD_GAS_CAP_EXCEEDED');
        return {estimatedGas:estimate,gasLimit:reservedGas,marginBps:policy.gasSafetyMarginBps};
      }
      const sizing=sizeGas(estimate,policy.gasCap,policy.gasSafetyMarginBps);
      // Verify the selected bound before the relay reserves a nonce. No paid transaction.
      const verified=await fixed('MONAD_SIMULATION_FAILED',()=>rpc.simulate(account,to as Hex,data,sizing.gasLimit));
      if(typeof verified!=='bigint'||verified<21000n)throw new Error('MONAD_GAS_ESTIMATE_REQUIRED');
      if(verified>sizing.gasLimit)throw new Error('MONAD_GAS_CAP_EXCEEDED');
      return sizing;
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
    receipt:async(hash)=>{const [,receipt]=await Promise.all([check(),fixed('MONAD_RECEIPT_READ_FAILED',()=>rpc.receipt(hash))]);return receipt;},
    block:async(number)=>{
      const block=async()=>{try{return await rpc.block({blockNumber:number});}catch(error){if(error instanceof BlockNotFoundError)return null;throw new Error('MONAD_BLOCK_READ_FAILED');}};
      const [,result]=await Promise.all([check(),block()]);return result;
    },
    head:async()=>{
      const [,b]=await Promise.all([check(),fixed('MONAD_FINALIZED_BLOCK_FAILED',()=>rpc.block({blockTag:'finalized'}))]);
      const age=now()-b.timestamp*1000n;
      if(age<0n||age>30000n)throw new Error('MONAD_STALE_OR_FUTURE_BLOCK');
      return b.number;
    },
  };
}
