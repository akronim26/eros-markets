// Task O37.1: the deployment's own addresses that handlers filter on (an Envio `where` sees only its own contract's
// addresses). Testnet from deployments/monad-testnet.json (a test checks them against it and config.yaml); mainnet
// (143) from the environment until it is deployed (config.mainnet.yaml).
type Addr = `0x${string}`
export const OWN: Record<number, { oracle: Addr | ''; adapter: Addr | '' }> = {
  10143: { oracle: '0xa87D6E10a7199666ec9F2e04866201E35AAf36A6', adapter: '0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1' },
  143: { oracle: (process.env.ENVIO_ORACLE_ADDRESS ?? '') as Addr | '', adapter: (process.env.ENVIO_UMA_ADAPTER_ADDRESS ?? '') as Addr | '' },
}
