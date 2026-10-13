import { expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type TransactionReceipt } from 'viem'
import { panelReceiptStatus } from '../src/receipt'

const id = `0x${'11'.repeat(32)}` as Hex
const evidence = `0x${'22'.repeat(32)}` as Hex
const blockHash = `0x${'33'.repeat(32)}` as Hex
const oracle = `0x${'44'.repeat(20)}` as Hex
const abi = parseAbi(['event PanelResultAccepted(bytes32 indexed id,uint8 phase,uint8[3] labels,uint16[3] calibratedBps,bytes32 evidenceHash,string evidenceURI,uint8 routedTo)'])
const data = encodeAbiParameters([{ type: 'uint8' }, { type: 'uint8[3]' }, { type: 'uint16[3]' }, { type: 'bytes32' }, { type: 'string' }, { type: 'uint8' }],
  [2, [1, 1, 1], [9000, 9000, 9000], evidence, `eros-snapshot:${evidence}`, 5])
const receipt = { status: 'success', blockNumber: 10n, blockHash,
  logs: [{ address: oracle, topics: encodeEventTopics({ abi, eventName: 'PanelResultAccepted', args: { id } }), data }],
} as Pick<TransactionReceipt, 'status' | 'blockNumber' | 'blockHash' | 'logs'>

test('matching successful acceptance requires a canonical finalized receipt', () => {
  expect(panelReceiptStatus(receipt, 9n, blockHash, oracle, id, 2, evidence)).toBe('pending')
  expect(panelReceiptStatus(receipt, 10n, evidence, oracle, id, 2, evidence)).toBe('pending')
  expect(panelReceiptStatus(receipt, 10n, blockHash, oracle, id, 2, evidence)).toBe('confirmed')
  expect(panelReceiptStatus({ ...receipt, status: 'reverted' }, 10n, blockHash, oracle, id, 2, evidence)).toBe('reverted')
})

test('receipt success alone or another market, phase, evidence or emitter cannot mark completion', () => {
  expect(() => panelReceiptStatus({ ...receipt, logs: [] }, 10n, blockHash, oracle, id, 2, evidence)).toThrow('no matching')
  for (const args of [[oracle, evidence, 2, evidence], [oracle, id, 1, evidence], [oracle, id, 2, id], [`0x${'55'.repeat(20)}`, id, 2, evidence]] as [Hex, Hex, number, Hex][]) {
    expect(() => panelReceiptStatus(receipt, 10n, blockHash, ...args)).toThrow('no matching')
  }
})
