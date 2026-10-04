// This deployment's addresses, which handlers filter on because an Envio `where` sees only its own contract's address.
// Mainnet comes from the environment until it is deployed.
type Addr = `0x${string}`
export const OWN: Record<number, { oracle: Addr | ''; adapter: Addr | '' }> = {
  10143: { oracle: '0xa87D6E10a7199666ec9F2e04866201E35AAf36A6', adapter: '0x1387bC4d10acd2aFB0C85b6f62a51Ad91600C3A1' },
  143: { oracle: (process.env.ENVIO_ORACLE_ADDRESS ?? '') as Addr | '', adapter: (process.env.ENVIO_UMA_ADAPTER_ADDRESS ?? '') as Addr | '' },
}
