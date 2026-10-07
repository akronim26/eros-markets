import { getAddress } from 'viem'

/** Pins a fresh indexer's event filters to a verified base, before market discovery begins. */
export function verifiedOracleAddresses(value: unknown) {
  const v = value as { passed?: boolean; chainId?: number; verifiedAt?: { blockNumber?: unknown; blockHash?: unknown }; contracts?: Record<string, { address?: string; codehash?: string; deployBlock?: number }> }
  if (!v || v.passed !== true || v.chainId !== 10143 || !v.verifiedAt
    || !/^(0|[1-9][0-9]*)$/.test(String(v.verifiedAt.blockNumber))
    || !/^0x[0-9a-fA-F]{64}$/.test(String(v.verifiedAt.blockHash))) throw new Error('VERIFIED_INDEXER_BASE_REQUIRED')
  const contract = (name: string) => {
    const c = v.contracts?.[name]
    if (!c || !/^0x[0-9a-fA-F]{40}$/.test(c.address ?? '') || /^0x0{40}$/.test(c.address!)
      || !/^0x[0-9a-fA-F]{64}$/.test(c.codehash ?? '') || !Number.isSafeInteger(c.deployBlock) || c.deployBlock! < 0
      || BigInt(c.deployBlock!) > BigInt(String(v.verifiedAt!.blockNumber))) throw new Error('INVALID_INDEXER_CONTRACT_PIN')
    return getAddress(c.address!)
  }
  return { registry: contract('MarketRegistry'), oracle: contract('ResolutionOracle'), adapter: contract('UmaAdapter') }
}
