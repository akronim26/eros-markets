import { describe, expect, test } from 'bun:test'
import { recordCanonicalPlanReceipt } from '../src/fresh-testnet'
import type { Address, Hex } from 'viem'

type Input = Parameters<typeof recordCanonicalPlanReceipt>[0]
const hash = `0x${'ab'.repeat(32)}` as Hex
const otherHash = `0x${'cd'.repeat(32)}` as Hex
const blockHash = `0x${'ef'.repeat(32)}` as Hex
const owner = `0x${'aa'.repeat(20)}` as Address
const target = `0x${'bb'.repeat(20)}` as Address
function fixture(): Input {
  return {
    plan: { deployer: owner },
    step: { name: 'fixture-call', nonce: 7, to: target, data: '0xabcd', valueWei: '5' },
    entry: { hash, raw: '0x0102' },
    receipt: { status: 'success', transactionHash: hash, blockNumber: 99n, blockHash, contractAddress: null },
    canonical: { number: 99n, hash: blockHash },
    transaction: { hash, from: owner, to: target, nonce: 7, input: '0xabcd', value: 5n,
      blockNumber: 99n, blockHash },
  }
}
function rejected(input: Input) {
  const pending = structuredClone(input.entry)
  expect(() => recordCanonicalPlanReceipt(input)).toThrow('CANONICAL_RECEIPT_MISMATCH')
  expect(input.entry).toEqual(pending) // Keep uncertain signed bytes available for reconciliation.
}

describe('exact canonical deployment receipt', () => {
  test('rejects a successful replacement receipt paired with a cached pending original', () => {
    const input = fixture()
    input.receipt.transactionHash = otherHash
    input.transaction.blockHash = null
    input.transaction.blockNumber = null
    rejected(input)
  })

  test('rejects a different receipt hash even when all other fields match', () => {
    const input = fixture(); input.receipt.transactionHash = otherHash; rejected(input)
  })

  test('rejects a different fetched transaction hash', () => {
    const input = fixture(); input.transaction.hash = otherHash; rejected(input)
  })

  test('requires transaction and canonical block membership to match the receipt', () => {
    for (const change of [
      (i: Input) => { i.transaction.blockNumber = null },
      (i: Input) => { i.transaction.blockNumber = 98n },
      (i: Input) => { i.transaction.blockHash = null },
      (i: Input) => { i.transaction.blockHash = otherHash },
      (i: Input) => { i.canonical.number = null },
      (i: Input) => { i.canonical.number = 98n },
      (i: Input) => { i.canonical.hash = null },
      (i: Input) => { i.canonical.hash = otherHash },
    ]) { const input = fixture(); change(input); rejected(input) }
  })

  test('retains sender, nonce, value, input and target checks', () => {
    for (const change of [
      (i: Input) => { i.transaction.from = target },
      (i: Input) => { i.transaction.nonce++ },
      (i: Input) => { i.transaction.value++ },
      (i: Input) => { i.transaction.input = '0x1234' },
      (i: Input) => { i.transaction.to = owner },
    ]) { const input = fixture(); change(input); rejected(input) }
  })

  test('an exact canonical revert is a known failure and retains signed bytes', () => {
    const input = fixture(); input.receipt.status = 'reverted'
    const pending = structuredClone(input.entry)
    expect(() => recordCanonicalPlanReceipt(input)).toThrow('TRANSACTION_REVERTED:fixture-call:')
    expect(input.entry).toEqual(pending)
    delete input.step.to
    input.step.expectedAddress = target
    input.transaction.to = null
    expect(() => recordCanonicalPlanReceipt(input)).toThrow('TRANSACTION_REVERTED:fixture-call:')
    expect(input.entry).toEqual(pending)
    input.receipt.transactionHash = otherHash
    rejected(input) // A replacement revert is still an identity mismatch.
  })

  test('only exact confirmation records the receipt and discards signed bytes', () => {
    const input = fixture()
    recordCanonicalPlanReceipt(input)
    expect(input.entry.raw).toBeUndefined()
    expect(input.entry.receipt).toEqual({ ...input.receipt, blockNumber: '99' })
  })

  test('hex case differences do not change identity', () => {
    const input = fixture()
    const upper = (value: Hex) => `0x${value.slice(2).toUpperCase()}` as Hex
    input.receipt.transactionHash = upper(hash)
    input.receipt.blockHash = upper(blockHash)
    input.transaction.hash = upper(hash)
    input.transaction.blockHash = upper(blockHash)
    input.transaction.from = upper(owner)
    input.transaction.to = upper(target)
    input.transaction.input = '0xABCD'
    recordCanonicalPlanReceipt(input)
    expect(input.entry.raw).toBeUndefined()
  })

  test('creation receipts must confirm the predicted address and have no call target', () => {
    const input = fixture()
    delete input.step.to
    input.step.expectedAddress = target
    input.transaction.to = null
    input.receipt.contractAddress = owner
    rejected(input)
    input.receipt.contractAddress = target
    recordCanonicalPlanReceipt(input)
    expect(input.entry.raw).toBeUndefined()
    const badTarget = fixture()
    delete badTarget.step.to
    badTarget.step.expectedAddress = target
    badTarget.receipt.contractAddress = target
    rejected(badTarget)
  })
})
