import fresh from "../../../artifacts/deployments/monad-testnet-20261006/public-manifest.json";
import current from "../../../frontend/src/config/public-manifest.json";
import { readFileSync } from 'node:fs'
import { verifiedOracleAddresses } from './verified-addresses'
// This deployment's addresses, which handlers filter on because an Envio `where` sees only its own contract's address.
// Mainnet comes from the environment until it is deployed.
type Addr = `0x${string}`
if (process.env.ENVIO_DEPLOYMENT && !['current', 'historical', 'monad-testnet-20261006', 'verified-monad-testnet'].includes(process.env.ENVIO_DEPLOYMENT)) throw new Error('Unknown indexer deployment');
const verified = process.env.ENVIO_DEPLOYMENT === 'verified-monad-testnet'
  ? verifiedOracleAddresses(JSON.parse(readFileSync(process.env.ENVIO_VERIFIED_MANIFEST || '', 'utf8')))
  : !process.env.ENVIO_DEPLOYMENT || process.env.ENVIO_DEPLOYMENT === 'current' ? verifiedOracleAddresses(current) : undefined
export const OWN: Record<number, { oracle: Addr | ''; adapter: Addr | '' }> = {
  10143: verified ? { oracle: verified.oracle, adapter: verified.adapter } : process.env.ENVIO_DEPLOYMENT === 'monad-testnet-20261006'
    ? { oracle: fresh.contracts.ResolutionOracle.address as Addr, adapter: fresh.contracts.UmaAdapter.address as Addr }
    : { oracle: '0xa87D6E10a7199666ec9F2e04866201E35AAf36A6', adapter: '0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1' },
  143: { oracle: (process.env.ENVIO_ORACLE_ADDRESS ?? '') as Addr | '', adapter: (process.env.ENVIO_UMA_ADAPTER_ADDRESS ?? '') as Addr | '' },
}
