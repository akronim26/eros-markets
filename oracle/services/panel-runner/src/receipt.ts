import { ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { parseEventLogs, type Hex, type TransactionReceipt } from 'viem'

export function panelReceiptStatus(receipt: Pick<TransactionReceipt, 'status' | 'blockNumber' | 'blockHash' | 'logs'>,
  finalized: bigint, canonicalHash: Hex, oracle: Hex, id: Hex, phase: number, evidenceHash: Hex): 'pending' | 'reverted' | 'confirmed' {
  if (receipt.blockNumber > finalized || receipt.blockHash !== canonicalHash) return 'pending'
  if (receipt.status === 'reverted') return 'reverted'
  const accepted = parseEventLogs({ abi: ResolutionOracleAbi, eventName: 'PanelResultAccepted', logs: receipt.logs })
    .some(log => {
      const args = log.args as unknown as { id: Hex; phase: number; evidenceHash: Hex }
      return log.address.toLowerCase() === oracle.toLowerCase() && args.id.toLowerCase() === id.toLowerCase()
        && Number(args.phase) === phase && args.evidenceHash.toLowerCase() === evidenceHash.toLowerCase()
    })
  if (!accepted) throw new Error('Finalized panel transaction has no matching PanelResultAccepted event; operator reconciliation required')
  return 'confirmed'
}
