import { DurableRelay } from './durable-relay.js';
import type { LocalRelayTransport, RelayPolicy } from './durable-relay.js';
import type { PacketStore } from './packet-store.js';
export type { LocalRelayTransport, RelayPolicy, DeliveryState, DeliveryRecord } from './durable-relay.js';
/** Local-only relay wrapper. No network/profile override is accepted. */
export class LocalRelay extends DurableRelay {
  constructor(path:string,packets:PacketStore,transport:LocalRelayTransport,policy:RelayPolicy,now:()=>bigint=()=>BigInt(Date.now())){
    super(path,packets,transport,policy,now,{chainId:31337n});
  }
}
