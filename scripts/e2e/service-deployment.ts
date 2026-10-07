import { deploymentsSchema } from '../../oracle/packages/oracle-sdk/src/deployments'
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest'

/** Derive every oracle service identity from this verified deployment, never a historical file. */
export function oracleServiceDeployment(input: unknown, base: { chainId: number; deployer: string; roles: Record<string, string>; infrastructure: { forwarder: string } }, globalsVersion: number) {
  const manifest = toPublicManifest(input), c = manifest.contracts, roles = base.roles
  if (manifest.chainId !== 10143 || base.chainId !== manifest.chainId || !manifest.verifiedAt) throw Error('VERIFIED_TESTNET_DEPLOYMENT_REQUIRED')
  const at = (key: string) => { if (!c[key]) throw Error(`MISSING_SERVICE_CONTRACT:${key}`); return c[key].address }
  const zeroHash = `0x${'00'.repeat(32)}`, zeroAddress = `0x${'00'.repeat(20)}`
  return deploymentsSchema.parse({
    network: 'monad-testnet', chainId: manifest.chainId, creChainSelector: '2183018362218727504', usdc: at('CollateralToken'),
    roles: { timelock: at('Timelock'), teamSafe: base.deployer, guardianSafe: base.deployer, lister: base.deployer },
    contracts: c,
    uma: { finder: at('Finder'), store: at('Store'), addressWhitelist: at('AddressWhitelist'), identifierWhitelist: at('IdentifierWhitelist'),
      oov3: at('OptimisticOracleV3'), sandboxOracle: at('ErosSandboxOracle'), finalFeeAtoms: '1000000' },
    cre: { mockForwarder: base.infrastructure.forwarder, keystoneForwarder: base.infrastructure.forwarder,
      orgOwner: zeroAddress, workflowName: 'eros-resolution-sim', workflowIds: [zeroHash, zeroHash], simRelayers: [roles.SIM_RELAYER] },
    trustSets: [{ id: 1, production: false, active: true, attestor: roles.RUNNER_ATTESTOR,
      committee: [roles.COMMITTEE_1, roles.COMMITTEE_2, roles.COMMITTEE_3].sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      threshold: 2, watchdog: roles.WATCHDOG, venue: at('UmaAdapter') }],
    globalsVersion, timelockOps: [],
  })
}
