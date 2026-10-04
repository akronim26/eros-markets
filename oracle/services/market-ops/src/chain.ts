import { readFileSync } from 'node:fs'
import { MarketRegistryAbi, ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Call, Snapshot, Transport } from './operations'
import { equalHex, type Manifest } from './schema'

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
  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined
  if (account && !equalHex(account.address, manifest.sender)) throw new Error('Signing account does not match manifest.sender')
  const callAbi = (call: Call): Abi => call.functionName === 'requestEarlyCheck' ? ResolutionOracleAbi : engineAbi
  const readEngine = (functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) => client.readContract({ address: manifest.engine, abi: engineAbi, functionName, args, blockNumber })

  return {
    async snapshot() {
      if (await client.getChainId() !== manifest.chainId) throw new Error('RPC chain does not match manifest')
      const block = await client.getBlock({ blockTag: 'latest' })
      const blockNumber = block.number
      const [engineCode, oracleCode, listingHash, rawListing, halt, risk] = await Promise.all([
        client.getCode({ address: manifest.engine, blockNumber }),
        client.getCode({ address: manifest.oracle, blockNumber }),
        readEngine('listingHash', [], blockNumber),
        readEngine('listing', [], blockNumber),
        readEngine('getHaltSnapshot', [], blockNumber),
        readEngine('marketRiskView', [], blockNumber),
      ])
      if (!engineCode || !equalHex(keccak256(engineCode), manifest.engineCodeHash)) throw new Error('Engine runtime hash mismatch')
      if (!oracleCode || !equalHex(keccak256(oracleCode), manifest.oracleCodeHash)) throw new Error('Oracle runtime hash mismatch')
      if (!equalHex(listingHash as Hex, manifest.listingHash)) throw new Error('Listing hash mismatch')
      const listing = rawListing as Listing
      if (!equalHex(listing.marketId, manifest.marketId) || !equalHex(listing.resolutionAuthority, manifest.oracle)) throw new Error('Listing market or oracle mismatch')
      const [resolution, core, source] = await Promise.all([
        client.readContract({ address: manifest.oracle, abi: ResolutionOracleAbi, functionName: 'getResolution', args: [manifest.marketId], blockNumber }),
        client.readContract({ address: listing.registry, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [manifest.marketId], blockNumber }),
        readEngine('sourceState', [listing.indexSourceId], blockNumber),
      ])
      if (!equalHex(core.engine, manifest.engine) || !equalHex(core.monitor, listing.monitor)) throw new Error('Registry and engine identity mismatch')
      const sourceState = source as Omit<Snapshot['source'], 'id'>
      if (!equalHex(sourceState.signer, listing.indexSigner) || !equalHex(sourceState.rulesHash, listing.indexRulesHash)) throw new Error('Source differs from immutable listing')
      return {
        block: blockNumber, timestamp: block.timestamp, halted: (halt as { halted: boolean }).halted,
        scheduledT: listing.scheduledT, monitor: listing.monitor,
        monitorRestricted: (risk as { monitorRestricted: boolean }).monitorRestricted,
        oracleState: resolution.state, source: { ...sourceState, id: listing.indexSourceId },
      }
    },
    async digest(observation, block) {
      return await readEngine('observationDigest', [observation], block) as Hex
    },
    async simulate(call) {
      const { result } = await client.simulateContract({ address: call.target, abi: callAbi(call), functionName: call.functionName, args: call.args, account: manifest.sender, gas: call.gas })
      return result
    },
    async prepare(call) {
      if (!account) throw new Error('Broadcast requires MARKET_OPS_PRIVATE_KEY')
      const [latestNonce, pendingNonce] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      ])
      if (latestNonce !== pendingNonce) throw new Error('Sender has an untracked pending transaction; reconcile it first')
      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
      const data = encodeFunctionData({ abi: callAbi(call), functionName: call.functionName, args: call.args })
      const request = await wallet.prepareTransactionRequest({ account, chain, to: call.target, data, gas: call.gas, nonce: latestNonce })
      const rawTransaction = await wallet.signTransaction(request)
      return { rawTransaction, hash: keccak256(rawTransaction) }
    },
    async broadcast(rawTransaction) {
      try {
        return await client.sendRawTransaction({ serializedTransaction: rawTransaction })
      } catch (error) {
        if (/already known|known transaction|already imported/i.test(String(error))) return keccak256(rawTransaction)
        throw error
      }
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
