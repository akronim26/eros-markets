/** Disposable actor 18 only, on a verified loopback Anvil chain. No public-network signing path. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, http, parseAbi, type Abi, type Address, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { createTraderClient, toPublicManifest, OrderKind, RegistryBookRiskEngineAbi, CollateralVaultAbi, ResolutionOracleAbi, MarketRegistryAbi } from '../src/browser'
import { assertLocalRpc, json, LocalReadModel, manifestSchema, type ReadClient } from '../../../services/local-integration/src/read-model'
import { retryLocalRead, waitForLocalFinality } from './local-rpc-readiness'

const [manifestPath, phase, output] = process.argv.slice(2)
if (!manifestPath || !output || !['prepare', 'claim'].includes(phase)) throw new Error('Usage: local-trader-smoke.ts manifest.json prepare|claim output.json')
const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
assertLocalRpc(manifest.rpcUrl)
if (!manifest.contracts.MockUSDC || manifest.contracts.MockUSDC.address !== manifest.contracts.CollateralToken.address) throw new Error('DISPOSABLE_COLLATERAL_REQUIRED')
const transport = http(manifest.rpcUrl, { timeout: 10_000, retryCount: 0, fetchOptions: { redirect: 'error' } })
const publicClient = createPublicClient({ chain: anvil, transport, cacheTime: 0 })
if (await publicClient.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_ONLY')
const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 18 })
const wallet = createWalletClient({ account, chain: anvil, transport })
const sdk = createTraderClient(toPublicManifest(manifest), 'terminal', account.address)
sdk.assertWallet(await publicClient.getChainId(), account.address)
const model = new LocalReadModel(manifest, { engine: RegistryBookRiskEngineAbi, vault: CollateralVaultAbi, token: erc20Abi,
  oracle: ResolutionOracleAbi, registry: MarketRegistryAbi }, publicClient as unknown as ReadClient)
await model.snapshot([account.address])
const initialWallet = await publicClient.readContract(sdk.walletBalance())
const receipts: Array<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex; from: Address; to: Address; gas: bigint; gasUsed: bigint; status: string; operation: string }> = []
const saveProgress = () => writeFileSync(output, json({ scope: 'local-only', chainId: 31337, phase, owner: account.address,
  sourceCommit: manifest.sourceCommit, manifestVersion: 1, passed: false, receipts }) + '\n')
saveProgress()
type Request = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; account: Address; chainId: number }

async function send(request: Request) {
  sdk.assertWallet(await publicClient.getChainId(), request.account)
  if (request.chainId !== 31337) throw new Error('LOCAL_CHAIN_ONLY')
  const estimated = await retryLocalRead(async () => {
    // Monad Anvil's default pending-state estimate may race execution availability.
    // Both the simulation and measured estimate use one explicit available block.
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    await publicClient.simulateContract({ ...request, blockNumber: block.number })
    return publicClient.estimateContractGas({ ...request, blockNumber: block.number })
  })
  const gas = (estimated * 130n + 99n) / 100n
  if (gas >= 30_000_000n) throw new Error('LOCAL_TRANSACTION_GAS_LIMIT')
  const hash = await wallet.sendTransaction({ to: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }), gas })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000, pollingInterval: 200 })
  if (receipt.status !== 'success') throw new Error(`SDK_TRANSACTION_REVERTED:${request.functionName}`)
  await waitForLocalFinality(publicClient, receipt)
  const transaction = await publicClient.getTransaction({ hash })
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash !== receipt.blockHash || transaction.from.toLowerCase() !== account.address.toLowerCase()
      || transaction.to?.toLowerCase() !== request.address.toLowerCase() || transaction.gas !== gas) throw new Error('SDK_RECEIPT_IDENTITY_MISMATCH')
  receipts.push({ transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, from: account.address,
    to: request.address, gas, gasUsed: receipt.gasUsed, status: receipt.status, operation: request.functionName })
  saveProgress()
  return receipt
}

if (phase === 'prepare') {
  if (await publicClient.readContract(sdk.participantId()) !== 0 || initialWallet !== 0n) throw new Error('SDK_OWNER_ALREADY_USED')
  await send({ address: sdk.token, abi: parseAbi(['function mint(address owner,uint256 atoms)']), functionName: 'mint',
    args: [account.address, 11_000_000n], account: account.address, chainId: 31337 })
  await send(sdk.approve(11_000_000n))
  await send(sdk.deposit(11_000_000n))
  await send(sdk.allocate(6_000_000n))
  const trader = await publicClient.readContract(sdk.participantId())
  if (trader === 0) throw new Error('SDK_OWNER_NOT_REGISTERED')
  // Interior fixture prices obey the bootstrap INDEX band. Preview remains authoritative.
  const order = { kind: OrderKind.POST_ONLY, isBuy: true, reduceOnly: false, tick: 499, size: 1_000n, maxFills: 8, expiryBlock: 0 }
  const preview = await publicClient.readContract(sdk.previewOrder(trader, order))
  if (preview.acceptedCapLots !== order.size) throw new Error('SDK_ORDER_NOT_ADMISSIBLE')
  const placed = await send(sdk.placeOrder(order))
  const ids = placed.logs.filter(log => log.address.toLowerCase() === sdk.market.engine.toLowerCase()).flatMap(log => {
    try {
      const event = decodeEventLog({ abi: RegistryBookRiskEngineAbi, data: log.data, topics: log.topics })
      return event.eventName === 'OrderPlaced' && event.args.trader === trader ? [event.args.id] : []
    } catch { return [] }
  })
  if (ids.length !== 1) throw new Error('SDK_ORDER_RECEIPT_MISMATCH')
  await send(sdk.cancel(ids[0]))
  const cancelled = await publicClient.readContract({ address: sdk.market.engine, abi: RegistryBookRiskEngineAbi, functionName: 'getOrder', args: [ids[0]] })
  if (cancelled.size !== 0n) throw new Error('SDK_CANCEL_NOT_RECONCILED')
  await send(sdk.placeOrder({ ...order, tick: 498 }))
  await send(sdk.cancelAll())
  await send(sdk.release(5_000_000n))
  await send(sdk.withdraw(10_000_000n))
  const [balance, free, risk] = await Promise.all([
    publicClient.readContract(sdk.walletBalance()), publicClient.readContract(sdk.freeBalance()), publicClient.readContract(sdk.accountRisk(trader)),
  ])
  if (balance !== 10_000_000n || free !== 0n || risk.cashQ !== 10n ** 24n || risk.positionLots !== 0n) throw new Error('SDK_OWNER_ACCOUNTING_MISMATCH')
} else {
  const [status, claimable] = await Promise.all([publicClient.readContract(sdk.settlement()), publicClient.readContract(sdk.claimable())])
  if (!status.claimsEnabled || claimable !== 1_000_000n || initialWallet !== 10_000_000n) throw new Error('SDK_CLAIM_NOT_READY')
  await send(sdk.claim())
  if (await publicClient.readContract(sdk.walletBalance()) !== 11_000_000n || await publicClient.readContract(sdk.claimable()) !== 0n) throw new Error('SDK_CLAIM_RECIPIENT_MISMATCH')
}
for (const receipt of receipts) {
  if ((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('SDK_RECEIPT_REORGED')
}
const snapshot = await model.snapshot([account.address])
writeFileSync(output, json({ scope: 'local-only', chainId: 31337, phase, owner: account.address,
  sourceCommit: manifest.sourceCommit, manifestVersion: 1, passed: true, receipts, block: snapshot.block,
  account: snapshot.markets.find(market => market.name === 'terminal')?.accounts[0] }) + '\n')
console.log(json({ phase, owner: account.address, passed: true, receipts: receipts.length }))
