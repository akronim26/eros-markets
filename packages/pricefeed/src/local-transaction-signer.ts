import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { DurableTransactionSigner } from './durable-transaction-signer.js';
export { canonicalTransactionRequest, parseTransactionRequest } from './durable-transaction-signer.js';
export type { RelayTransactionRequest, TransactionReservation, TransactionJournal } from './durable-transaction-signer.js';
/** Independent durable transaction journal; public fixture key, chain 31337 only. */
export class LocalTransactionSigner extends DurableTransactionSigner {
  constructor(path:string,create=false){super(path,create,privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex),31337);}
}
