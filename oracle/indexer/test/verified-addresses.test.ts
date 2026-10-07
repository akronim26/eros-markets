import { describe, expect, it } from 'vitest'
import { verifiedOracleAddresses } from '../src/verified-addresses'
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const hash = `0x${'a'.repeat(64)}`
const report = { passed: true, chainId: 10143, verifiedAt: { blockNumber: '100', blockHash: hash }, contracts: {
  MarketRegistry: { address: address(1), codehash: hash, deployBlock: 98 },
  ResolutionOracle: { address: address(2), codehash: hash, deployBlock: 97 },
  UmaAdapter: { address: address(3), codehash: hash, deployBlock: 99 },
} }
describe('verified fresh indexer address pins', () => {
  it('derives the registry, oracle and venue from the same verified base', () => {
    expect(verifiedOracleAddresses(report)).toEqual({ registry: address(1), oracle: address(2), adapter: address(3) })
    expect(verifiedOracleAddresses({ ...report, contracts: { ...report.contracts, ResolutionOracle: { ...report.contracts.ResolutionOracle, address: address(4) } } }).oracle).toBe(address(4))
  })
  it('rejects unverified, wrong-chain, missing, malformed and future contract identities', () => {
    for (const patch of [{ passed: false }, { chainId: 31337 }, { verifiedAt: undefined }, { verifiedAt: { blockNumber: '100', blockHash: '0x01' } }, { contracts: {} }]) expect(() => verifiedOracleAddresses({ ...report, ...patch })).toThrow()
    for (const patch of [{ address: address(0) }, { address: 'invalid' }, { codehash: '0x12' }, { deployBlock: 101 }, { deployBlock: -1 }]) expect(() => verifiedOracleAddresses({ ...report, contracts: { ...report.contracts, ResolutionOracle: { ...report.contracts.ResolutionOracle, ...patch } } })).toThrow()
  })
})
