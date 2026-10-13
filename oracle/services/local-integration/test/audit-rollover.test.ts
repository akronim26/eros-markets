import { expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Address, type Hex } from 'viem'
import { RolloverBatcherAbi } from '../../market-ops/src/rollover-batch'
import { auditRolloverBatch, LOCAL_OPERATOR } from '../src/audit-rollover'
import { manifestSchema } from '../src/read-model'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
function fixture(work = 0, start = 0n, count = 4n, pages = 1) {
  const code = '0x600100' as Hex, engine = address(1), helper = address(2)
  const manifest = manifestSchema.parse({ scope: 'local-only', chainId: 31337, sourceCommit: 'fixture', rpcUrl: 'http://127.0.0.1:18545', accounts: {},
    contracts: { ...Object.fromEntries(['MarketRegistry', 'ResolutionOracle', 'CollateralVault', 'CollateralToken']
      .map((name, index) => [name, { address: address(index + 10), codehash: keccak256(code), deployBlock: 0 }])),
      RolloverBatcher: { address: helper, codehash: keccak256(code), deployBlock: 0 } },
    markets: [{ name: 'demo', engine, marketId: hash(1), sourceId: hash(2), listingHash: hash(3), codehash: keccak256(code), deployBlock: 0 }] })
  const wanted = start + 32n * BigInt(pages), end = wanted < count ? wanted : count
  const event = (overrides: { engine?: Address; cursor?: bigint; count?: bigint; pages?: number; completed?: boolean } = {}) => ({ address: helper,
    topics: encodeEventTopics({ abi: RolloverBatcherAbi, eventName: 'RolloverAdvanced', args: { engine: overrides.engine ?? engine, epoch: 2n } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bool' }],
      [overrides.cursor ?? end, overrides.count ?? count, overrides.pages ?? Number((end - start + 31n) / 32n), overrides.completed ?? (end === count)]),
  })
  const receipt = { transactionHash: hash(10), blockNumber: 10n, blockHash: hash(10), status: 'success', gasUsed: 70000n, logs: [event()] }
  const tx = { hash: hash(10), from: LOCAL_OPERATOR, to: helper, value: 0n, gas: 106000n,
    input: encodeFunctionData({ abi: RolloverBatcherAbi, functionName: 'rollover', args: [engine, 2n, work, start, pages] }) }
  const metadata = { pages, estimatedGas: '80000', gasLimit: '106000', estimateBlock: '8', estimationMs: 120 }
  const reads: Array<{ address: Address; blockNumber: bigint }> = []
  const client = { getCode: async (args: { address: Address; blockNumber: bigint }): Promise<Hex> => { reads.push(args); return code } }
  return { manifest, engine, helper, receipt, tx, metadata, client, reads, event,
    run: () => auditRolloverBatch(manifest, engine, receipt, tx, metadata, client) }
}

test('audits exact helper identity, operator calldata, current estimate margin and completed progress', async () => {
  const f = fixture(), result = await f.run()
  expect(result.progress).toEqual({ engine: f.engine, epoch: 2n, cursor: 4n, count: 4n, pages: 1, completed: true })
  expect(f.reads).toEqual([{ address: f.helper, blockNumber: 10n }, { address: f.engine, blockNumber: 10n }])
})

test('audits partial sweeps and zero-page finish with the actual expected cursor', async () => {
  const partial = await fixture(1, 352n, 1024n, 11).run()
  expect(partial.progress.cursor).toBe(704n); expect(partial.progress.completed).toBe(false)
  const finish = await fixture(1, 1024n, 1024n, 1).run()
  expect(finish.progress.pages).toBe(0); expect(finish.progress.completed).toBe(true)
})

test('rejects wrong owner, engine, helper runtime and receipt-block engine runtime', async () => {
  const a = fixture(); a.tx.from = address(4); await expect(a.run()).rejects.toThrow('OPERATOR')
  const b = fixture(); b.tx.input = encodeFunctionData({ abi: RolloverBatcherAbi, functionName: 'rollover', args: [address(5), 2n, 0, 0n, 1] })
  await expect(b.run()).rejects.toThrow('CALLDATA')
  const c = fixture(); c.client.getCode = async () => '0x600200'; await expect(c.run()).rejects.toThrow('CODE_CHANGED')
  const d = fixture(); d.client.getCode = async args => args.address === d.engine ? '0x600200' : '0x600100'
  await expect(d.run()).rejects.toThrow('CODE_CHANGED')
})

test('rejects missing, duplicate, wrong-engine and impossible progress events', async () => {
  const a = fixture(); a.receipt.logs = []; await expect(a.run()).rejects.toThrow('PROGRESS_EVENT')
  const b = fixture(); b.receipt.logs.push(b.event()); await expect(b.run()).rejects.toThrow('PROGRESS_EVENT')
  for (const [change, error] of [[{ engine: address(9) }, 'EVENT_BINDING'], [{ cursor: 3n }, 'PROGRESS'],
    [{ pages: 0 }, 'PAGES'], [{ completed: false }, 'COMPLETION']] as const) {
    const f = fixture(); f.receipt.logs = [f.event(change)]; await expect(f.run()).rejects.toThrow(error)
  }
})

test('rejects fabricated gas, future estimate blocks, wrong page plan and invalid elapsed time', async () => {
  const a = fixture(); a.metadata.estimatedGas = '79000'; await expect(a.run()).rejects.toThrow('GAS_MARGIN')
  const b = fixture(); b.metadata.estimateBlock = '11'; await expect(b.run()).rejects.toThrow('ESTIMATE_BLOCK')
  const c = fixture(); c.metadata.pages = 2; await expect(c.run()).rejects.toThrow('PLAN_METADATA')
  const d = fixture(); d.metadata.estimationMs = -1; await expect(d.run()).rejects.toThrow('PLAN_METADATA')
  const e = fixture(); e.tx.gas = 30_000_001n; await expect(e.run()).rejects.toThrow('GAS_CAP')
})
