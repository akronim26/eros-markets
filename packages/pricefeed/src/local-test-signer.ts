import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { PacketDomain, PacketStore } from './packet-store.js';
import { DurableObservationSigner } from './durable-observation-signer.js';
/** Public fixture key only, chain 31337 only. */
export class LocalTestSigner extends DurableObservationSigner {
  constructor(path:string,domain:PacketDomain,store:PacketStore,now:()=>bigint){
    super(path,domain,store,now,privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex),31337n);
  }
}
