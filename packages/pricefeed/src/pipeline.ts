import { DurablePipeline, type PipelineWorker } from './durable-pipeline.js';
import type { LocalRelay, LocalRelayTransport, RelayPolicy } from './local-relay.js';
import type { PacketStore } from './packet-store.js';
import { prepareObservation, signPrepared } from './publication.js';
export type { RecoverableSigner, PipelineWorker, PipelineResult } from './durable-pipeline.js';
/** Original local-only pipeline: disabled configs and chain 31337, with no network override. */
export class LocalPipeline extends DurablePipeline {
  constructor(workers:readonly PipelineWorker[],packets:PacketStore,relay:LocalRelay,
    transport:LocalRelayTransport,policy:RelayPolicy,now:()=>bigint=()=>BigInt(Date.now())){
    super(workers,packets,relay,transport,policy,now,{chainId:31337n,prepare:prepareObservation,sign:signPrepared});
  }
}
