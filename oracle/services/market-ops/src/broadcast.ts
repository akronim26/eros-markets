import { keccak256, type Hex } from 'viem'
import { equalHex } from './schema'

export async function broadcastTracked(rawTransaction: Hex, rpc: {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>
  getTransaction(args: { hash: Hex }): Promise<{ hash: Hex }>
}): Promise<Hex> {
  const hash = keccak256(rawTransaction)
  try {
    return await rpc.sendRawTransaction({ serializedTransaction: rawTransaction })
  } catch (error) {
    if (/already known|known transaction|already imported/i.test(String(error))) return hash
    if (/nonce too low/i.test(String(error))) {
      // Receipt indexing may lag inclusion. Only the exact signed transaction
      // establishes an already-mined replay; an unrelated consumed nonce does not.
      const known = await rpc.getTransaction({ hash })
      if (equalHex(known.hash, hash)) return hash
    }
    throw error
  }
}
