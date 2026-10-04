import { DurableRelay, type LocalRelayTransport, type RelayPolicy } from './durable-relay.js';
import { DurablePipeline, type PipelineWorker } from './durable-pipeline.js';
import type { PacketStore } from './packet-store.js';
import { prepareMonadTestnetObservation, signMonadTestnetPrepared } from './publication.js';

export type TestnetRelayBudget={maxTransactions:number;totalMaxCostWei:bigint};
/** Explicit testnet-only pilot admission, never an enabled production MarketConfig. */
export class MonadTestnetRelay extends DurableRelay {
  constructor(path:string,packets:PacketStore,transport:LocalRelayTransport,policy:RelayPolicy,
    budget:TestnetRelayBudget,now:()=>bigint=()=>BigInt(Date.now())){
    super(path,packets,transport,{...policy},now,{chainId:10143n,...budget});
  }
}
export class MonadTestnetPipeline extends DurablePipeline {
  constructor(workers:readonly PipelineWorker[],packets:PacketStore,relay:MonadTestnetRelay,
    transport:LocalRelayTransport,policy:RelayPolicy,now:()=>bigint=()=>BigInt(Date.now())){
    if(workers.some(w=>!w.lifecycle||w.worker.config.requiredFeedUntil===null))throw new Error('MONAD_PUBLICATION_LIFECYCLE_REQUIRED');
    super(workers,packets,relay,transport,{...policy},now,
      {chainId:10143n,prepare:prepareMonadTestnetObservation,sign:signMonadTestnetPrepared});
  }
}
