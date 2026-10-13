import current from "../../../frontend/src/config/public-manifest.json";
import { readFileSync } from 'node:fs'
import { verifiedOracleAddresses } from './verified-addresses'
// This deployment's addresses, which handlers filter on because an Envio `where` sees only its own contract's address.
// Mainnet comes from the environment until it is deployed.
type Addr = `0x${string}`
if (process.env.ENVIO_DEPLOYMENT && !['current', 'verified-monad-testnet'].includes(process.env.ENVIO_DEPLOYMENT)) throw new Error('Unknown indexer deployment');
const verified = process.env.ENVIO_DEPLOYMENT === 'verified-monad-testnet'
  ? verifiedOracleAddresses(JSON.parse(readFileSync(process.env.ENVIO_VERIFIED_MANIFEST || '', 'utf8')))
  : verifiedOracleAddresses(current)
export const OWN: Record<number, { oracle: Addr | ''; adapter: Addr | '' }> = {
  10143: { oracle: verified.oracle, adapter: verified.adapter },
  143: { oracle: (process.env.ENVIO_ORACLE_ADDRESS ?? '') as Addr | '', adapter: (process.env.ENVIO_UMA_ADAPTER_ADDRESS ?? '') as Addr | '' },
}
