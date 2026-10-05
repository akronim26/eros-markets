import { indexer } from 'envio'
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { lc, logId, ts } from '../lib'

const events = ['AccountRegistered', 'AccountSynced', 'AccountTakenOver', 'AllOrdersCancelled', 'CashAllocated', 'Fill', 'FloorOrdersInvalidated', 'LiquidationOutcome', 'ObservationAccepted', 'OrderCancelled', 'OrderPlaced', 'OrderRejected', 'OrdersInvalidated', 'PairReduction', 'PairedPosting', 'PerpObservationRecorded'] as const
for (const kind of events) indexer.onEvent({ contract: 'TradingEngine', event: kind }, async ({ event, context }) => {
  const p = event.params as Record<string, unknown>
  const engine = lc(event.srcAddress)
  const owner = typeof p.owner === 'string' ? lc(p.owner) : undefined
  const orderKey = `${event.chainId}-${engine}-${p.id}`
  const cancelled = kind === 'OrderCancelled' ? await context.TradingOrderIdentity.get(orderKey) : undefined
  if (kind === 'OrderPlaced') context.TradingOrderIdentity.set({ id: orderKey, engine, orderId: BigInt(p.id as bigint), trader: BigInt(p.trader as bigint) })
  context.TradingEvent.set({ id: logId(event), chainId: event.chainId, engine, source: engine, kind, owner,
    trader: typeof p.trader === 'bigint' ? p.trader : typeof p.target === 'bigint' ? p.target : cancelled?.trader, maker: typeof p.maker === 'bigint' ? p.maker : typeof p.partner === 'bigint' ? p.partner : undefined,
    taker: typeof p.taker === 'bigint' ? p.taker : undefined, orderId: kind === 'OrderPlaced' || kind === 'OrderCancelled' ? BigInt(p.id as bigint) : kind === 'Fill' ? BigInt(p.makerOrder as bigint) : undefined,
    block: event.block.number, logIndex: event.logIndex, timestamp: ts(event), txHash: event.transaction.hash,
    payload: JSON.stringify(p, (_, v) => typeof v === 'bigint' ? v.toString() : v),
  })
  if (kind === 'AccountRegistered' && owner) context.TradingRegistration.set({ id: `${event.chainId}-${engine}-${owner}`, engine, owner, trader: BigInt(p.index as bigint) + 1n, block: event.block.number })
})

for (const kind of ['Allocation', 'Deposit', 'Escrowed', 'FeesPaid', 'FeesReclassified', 'KeeperFeeAssigned', 'Paid', 'Released'] as const) indexer.onEvent({ contract: 'TradingVault', event: kind }, async ({ event, context }) => {
  const p = event.params as Record<string, unknown>
  context.TradingEvent.set({ id: logId(event), chainId: event.chainId, engine: typeof p.engine === 'string' ? lc(p.engine) : '', source: lc(event.srcAddress), kind,
    owner: typeof p.owner === 'string' ? lc(p.owner) : undefined, trader: undefined, maker: undefined, taker: undefined, orderId: undefined,
    block: event.block.number, logIndex: event.logIndex, timestamp: ts(event), txHash: event.transaction.hash,
    payload: JSON.stringify(p, (_, v) => typeof v === 'bigint' ? v.toString() : v),
  })
})

// The registry is the discovery authority. A stub simply emits no trading events.
indexer.contractRegister({ contract: 'MarketRegistry', event: 'MarketListed' }, async ({ event, context }) => {
  context.chain.TradingEngine.add(event.params.engine)
})

indexer.contractRegister({ contract: 'MarketRegistry', event: 'FactorySet' }, async ({ event, context }) => {
  context.chain.TradingFactory.add(event.params.factory)
})

async function vaultToken(input: { chain: number; vault: string; block: number }) {
  const url = process.env.ENVIO_RPC_URL || (input.chain === 10143 ? 'https://testnet-rpc.monad.xyz' : input.chain === 143 ? 'https://rpc.monad.xyz' : undefined)
  if (!url) throw new Error('No RPC configured for trading vault discovery')
  return createPublicClient({ transport: http(url, { batch: true }) }).readContract({ address: input.vault as Address, abi: parseAbi(['function token() view returns (address)']), functionName: 'token', blockNumber: BigInt(input.block) })
}
indexer.contractRegister({ contract: 'TradingFactory', event: 'MarketDeployed' }, async ({ event, context }) => {
  context.chain.TradingEngine.add(event.params.engine)
  context.chain.TradingVault.add(event.params.vault)
  context.chain.CollateralToken.add(await vaultToken({ chain: event.chainId, vault: event.params.vault, block: event.block.number }))
})
indexer.onEvent({ contract: 'CollateralToken', event: 'Transfer' }, async ({ event, context }) => {
  context.CollateralTransfer.set({ id: logId(event), chainId: event.chainId, token: lc(event.srcAddress), from: lc(event.params.from), to: lc(event.params.to), atoms: event.params.value, block: event.block.number, logIndex: event.logIndex, timestamp: ts(event), txHash: event.transaction.hash })
})
