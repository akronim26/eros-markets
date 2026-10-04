import { decodeFunctionData, type Hex } from 'viem';
import type { MarketConfig } from './config.js';
import type { PacketDomain, PacketStore } from './packet-store.js';
import { DurableObservationSigner } from './durable-observation-signer.js';
import { DurableTransactionSigner, type RelayTransactionRequest, type TransactionReservation } from './durable-transaction-signer.js';
import { loadTestnetKey, testnetJournalPath } from './monad-keys.js';
import { INGRESS_ABI } from './wire.js';

export class MonadTestnetObservationSigner extends DurableObservationSigner {
  constructor(path:string,domain:PacketDomain,store:PacketStore,now:()=>bigint,keyPath:string,passwordPath:string){
    if(domain.chainId!==10143n)throw new Error('MONAD_TESTNET_ONLY');
    super(testnetJournalPath(path,true),structuredClone(domain),store,now,loadTestnetKey(keyPath,passwordPath,domain.signer),10143n);
  }
}
export type TestnetTransactionLimits={gasCap:bigint;maxFeePerGas:bigint;maxCostWei:bigint};
/** Fixed chain/receiver/call/value and gas ceilings; no arbitrary transaction signing. */
export class MonadTestnetTransactionSigner extends DurableTransactionSigner {
  private readonly destination:NonNullable<MarketConfig['destination']>;
  constructor(path:string,config:MarketConfig,keyPath:string,passwordPath:string,sender:string,
    private readonly limits:TestnetTransactionLimits,create=false){
    if(config.enabled||config.destination?.chainId!=='10143')throw new Error('MONAD_DISABLED_TESTNET_CONFIG_REQUIRED');
    if(limits.gasCap<=0n||limits.maxFeePerGas<=0n||limits.maxCostWei<limits.gasCap*limits.maxFeePerGas)
      throw new Error('BAD_TESTNET_TRANSACTION_LIMITS');
    super(testnetJournalPath(path,create),create,loadTestnetKey(keyPath,passwordPath,sender),10143);
    this.limits={...limits};
    this.destination=structuredClone(config.destination);
  }
  private checked(request:RelayTransactionRequest):void {
    const d=this.destination;
    if(request.to.toLowerCase()!==d.engineAddress.toLowerCase()||request.gas>this.limits.gasCap
      ||request.maxFeePerGas>this.limits.maxFeePerGas||request.gas*request.maxFeePerGas>this.limits.maxCostWei)
      throw new Error('TESTNET_TRANSACTION_SCOPE');
    try{
      const decoded=decodeFunctionData({abi:INGRESS_ABI,data:request.data});
      const o=decoded.args[0];
      if(decoded.functionName!=='submitObservation'||String(o.marketId).toLowerCase()!==d.marketId.toLowerCase()
        ||String(o.sourceId).toLowerCase()!==d.sourceId.toLowerCase()||String(o.sourceRulesHash).toLowerCase()!==d.sourceRulesHash.toLowerCase()
        ||!/^0x[0-9a-fA-F]{130}$/.test(decoded.args[1]))throw new Error();
    }catch{throw new Error('TESTNET_TRANSACTION_SCOPE');}
  }
  override async reconcile(reservations:readonly TransactionReservation[]):Promise<void>{
    for(const r of reservations)this.checked(r.request);
    await super.reconcile(reservations);
  }
  override async sign(request:RelayTransactionRequest):Promise<Hex>{this.checked(request);return super.sign(request);}
}
