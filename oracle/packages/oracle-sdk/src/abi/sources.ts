// The oracle ABIs the SDK carries (O30.1): every interface of Appendix C and every deployed contract, with the
// Solidity source `forge inspect` reads it from. oracle/abi/ holds the snapshot and its SHA256SUMS.
export const ORACLE_ROOT = new URL('../../../../', import.meta.url).pathname
export const ABI_DIR = `${ORACLE_ROOT}abi`

export const SOURCES: { name: string; source: string; kind: 'interface' | 'contract' }[] = [
  { name: 'IAssertionVenue', source: 'src/interfaces/IAssertionVenue.sol', kind: 'interface' },
  { name: 'IBondTreasury', source: 'src/interfaces/IBondTreasury.sol', kind: 'interface' },
  { name: 'IERC165', source: 'src/interfaces/IReceiver.sol', kind: 'interface' },
  { name: 'IEngineMonitorView', source: 'src/interfaces/IEngineMonitorView.sol', kind: 'interface' },
  { name: 'IKeeperRouter', source: 'src/interfaces/IKeeperRouter.sol', kind: 'interface' },
  { name: 'IMarketFactory', source: 'src/interfaces/IMarketFactory.sol', kind: 'interface' },
  { name: 'IMarketRegistry', source: 'src/interfaces/IMarketRegistry.sol', kind: 'interface' },
  { name: 'IOptimisticOracleV3', source: 'src/interfaces/IOptimisticOracleV3.sol', kind: 'interface' },
  { name: 'IOptimisticOracleV3CallbackRecipient', source: 'src/interfaces/IOptimisticOracleV3.sol', kind: 'interface' },
  { name: 'IReceiver', source: 'src/interfaces/IReceiver.sol', kind: 'interface' },
  { name: 'IResolutionOracle', source: 'src/interfaces/IResolutionOracle.sol', kind: 'interface' },
  { name: 'ResolutionOracle', source: 'src/ResolutionOracle.sol', kind: 'contract' },
  { name: 'MarketRegistry', source: 'src/MarketRegistry.sol', kind: 'contract' },
  { name: 'BondTreasury', source: 'src/BondTreasury.sol', kind: 'contract' },
  { name: 'KeeperRouter', source: 'src/KeeperRouter.sol', kind: 'contract' },
  { name: 'UmaAdapter', source: 'src/venues/UmaAdapter.sol', kind: 'contract' },
  { name: 'ErosSandboxOracle', source: 'src/venues/ErosSandboxOracle.sol', kind: 'contract' },
  { name: 'TestUSDC', source: 'src/testnet/TestUSDC.sol', kind: 'contract' },
  { name: 'StubMarketFactory', source: 'src/testnet/StubMarketFactory.sol', kind: 'contract' },
  { name: 'ResolutionEngineStub', source: 'src/testnet/ResolutionEngineStub.sol', kind: 'contract' },
]
