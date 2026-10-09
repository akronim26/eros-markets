import { readFileSync } from 'node:fs'
import { MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Call, Snapshot, Transport } from './operations'
import { equalHex, type Manifest } from './schema'
import { broadcastTracked } from './broadcast'
import { BatchEstimateOpaqueRevert, BatchGasLimitExceeded, isBatchGasLimitError, isOpaqueBatchEstimateRevert, RolloverBatcherAbi, verifyRolloverHelper } from './rollover-batch'
import { marketReadTransport } from './read-transport'

const engineAbi = JSON.parse(readFileSync(new URL('../../../../artifacts/risk/book-risk-engine-abi.json', import.meta.url), 'utf8')).abi as Abi

type Listing = {
  marketId: Hex
  registry: Address
  resolutionAuthority: Address
  monitor: Address
  scheduledT: bigint
  indexSourceId: Hex
  indexSigner: Address
  indexRulesHash: Hex
}

export function viemTransport(manifest: Manifest, rpcUrl: string, privateKey?: Hex): Transport {
  const chain = defineChain({ id: manifest.chainId, name: 'market-ops', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
  const client = createPublicClient({ chain, transport: marketReadTransport(rpcUrl, manifest.chainId) })
  const writer = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 5000, retryCount: 0 }) })
  const verifyWriter = async () => {
    if (await writer.getChainId() !== manifest.chainId) throw new Error('Writer RPC chain does not match manifest')
  }
  const runtimeHash = async (address: Address, blockNumber: bigint) => {
    // Creation eth_call returns EXTCODEHASH without downloading the large engine.
    const { data } = await client.call({ data: `0x73${address.slice(2)}3f60005260206000f3`, blockNumber })
    if (!data || !/^0x[\da-fA-F]{64}$/.test(data)) throw new Error('Invalid runtime hash response')
    return data
  }
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined
  if (account && !equalHex(account.address, manifest.sender)) throw new Error('Signing account does not match manifest.sender')
  const callAbi = (call: Pick<Call, 'functionName'>): Abi => call.functionName === 'rollover' ? RolloverBatcherAbi
    : call.functionName === 'requestEarlyCheck' ? ResolutionOracleAbi : engineAbi
  const readEngine = (functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) => client.readContract({ address: manifest.engine, abi: engineAbi, functionName, args, blockNumber })

  return {
    async snapshot() {
      const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' })])
      if (chainId !== manifest.chainId) throw new Error('RPC chain does not match manifest')
      const blockNumber = block.number
      const [engineCode, oracleCode, listingHash, rawListing, halt, risk, participants, epoch, work, cursor, count, resolution] = await Promise.all([
        runtimeHash(manifest.engine, blockNumber),
        runtimeHash(manifest.oracle, blockNumber),
        readEngine('listingHash', [], blockNumber),
        readEngine('listing', [], blockNumber),
        readEngine('getHaltSnapshot', [], blockNumber),
        readEngine('marketRiskView', [], blockNumber),
        readEngine('participantCount', [], blockNumber),
        readEngine('epoch', [], blockNumber),
        readEngine('work', [], blockNumber),
        readEngine('cursor', [], blockNumber),
        readEngine('sweepCount', [], blockNumber),
        client.readContract({ address: manifest.oracle, abi: ResolutionOracleAbi, functionName: 'getResolution', args: [manifest.marketId], blockNumber }),
        verifyRolloverHelper(manifest.rolloverHelper, blockNumber,
          (address, blockNumber) => client.getCode({ address, blockNumber })),
      ])
      if (!equalHex(engineCode, manifest.engineCodeHash)) throw new Error('Engine runtime hash mismatch')
      if (!equalHex(oracleCode, manifest.oracleCodeHash)) throw new Error('Oracle runtime hash mismatch')
      if (!equalHex(listingHash as Hex, manifest.listingHash)) throw new Error('Listing hash mismatch')
      const listing = rawListing as Listing
      if (!equalHex(listing.marketId, manifest.marketId) || !equalHex(listing.resolutionAuthority, manifest.oracle)) throw new Error('Listing market or oracle mismatch')
      const [core, source] = await Promise.all([
        client.readContract({ address: listing.registry, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [manifest.marketId], blockNumber }),
        readEngine('sourceState', [listing.indexSourceId], blockNumber),
      ])
      if (!equalHex(core.engine, manifest.engine) || !equalHex(core.monitor, listing.monitor)) throw new Error('Registry and engine identity mismatch')
      const sourceState = source as Omit<Snapshot['source'], 'id'>
      if (!equalHex(sourceState.signer, listing.indexSigner) || !equalHex(sourceState.rulesHash, listing.indexRulesHash)) throw new Error('Source differs from immutable listing')
      if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Snapshot block changed')
      const liquidationRisk = risk as { accountingState: number; liquidationCapLots: bigint; liquidationRemainingLots: bigint }
      return {
        block: blockNumber, timestamp: block.timestamp, halted: (halt as { halted: boolean }).halted,
        scheduledT: listing.scheduledT, monitor: listing.monitor,
        monitorRestricted: (risk as { monitorRestricted: boolean }).monitorRestricted,
        oracleState: resolution.state, source: { ...sourceState, id: listing.indexSourceId },
        liquidation: { participants: Number(participants), accountingState: liquidationRisk.accountingState,
          capLots: liquidationRisk.liquidationCapLots, remainingLots: liquidationRisk.liquidationRemainingLots },
        rollover: { timestamp: block.timestamp, scheduledT: listing.scheduledT, halted: (halt as { halted: boolean }).halted,
          epochId: (epoch as readonly bigint[])[0], epochEnd: (epoch as readonly bigint[])[2],
          work: Number(work), cursor: cursor as bigint, count: count as bigint },
      }
    },
    async digest(observation, block) {
      return await readEngine('observationDigest', [observation], block) as Hex
    },
    async simulate(call) {
      await verifyWriter()
      const { result } = await writer.simulateContract({ address: call.target, abi: callAbi(call), functionName: call.functionName, args: call.args, account: manifest.sender, gas: call.gas })
      return result
    },
    async estimateGas(call, blockNumber) {
      if (call.functionName !== 'rollover' || !manifest.rolloverHelper
        || !equalHex(call.target, manifest.rolloverHelper.address)) throw new Error('Only enrolled rollover batches use dynamic gas estimation')
      try {
        await verifyWriter()
        return await writer.estimateContractGas({ address: call.target, abi: callAbi(call), functionName: call.functionName,
          args: call.args, account: manifest.sender, blockNumber, gas: BigInt(manifest.rolloverHelper.gasCeiling) })
      } catch (error) {
        // Do not turn stale epoch/identity/custom reverts or transport errors into a smaller transaction.
        if (isBatchGasLimitError(error)) {
          throw new BatchGasLimitExceeded('Rollover batch estimate exceeds execution gas ceiling', { cause: error })
        }
        if (isOpaqueBatchEstimateRevert(error)) throw new BatchEstimateOpaqueRevert('Larger batch has an opaque empty RPC revert; no gas conclusion', { cause: error })
        throw error
      }
    },
    async prepare(call) {
      if (!account) throw new Error('Broadcast requires MARKET_OPS_PRIVATE_KEY')
      await verifyWriter()
      const [latestNonce, pendingNonce] = await Promise.all([
        writer.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        writer.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ])
      if (latestNonce !== pendingNonce) throw new Error('Sender has an untracked pending transaction; reconcile it first')
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
      const data = encodeFunctionData({ abi: callAbi(call), functionName: call.functionName, args: call.args })
      const request = await wallet.prepareTransactionRequest({ account, chain, to: call.target, data, gas: call.gas, nonce: latestNonce })
      const rawTransaction = await wallet.signTransaction(request)
      return { rawTransaction, hash: keccak256(rawTransaction) }
    },
    async broadcast(rawTransaction) {
      await verifyWriter()
      return broadcastTracked(rawTransaction, writer)
    },
    async receipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        const [canonical, finalized] = await Promise.all([
          client.getBlock({ blockNumber: receipt.blockNumber }),
          client.getBlock({ blockTag: 'finalized' }),
        ])
        if (!equalHex(canonical.hash, receipt.blockHash)) return null
        return { status: receipt.status, block: receipt.blockNumber, finalized: finalized.number >= receipt.blockNumber }
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        throw error
      }
    },
  }
}
