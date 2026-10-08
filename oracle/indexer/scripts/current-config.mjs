import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../../frontend/src/config/public-manifest.json', root), 'utf8'))
if (manifest.chainId !== 10143 || manifest.scope !== 'testnet-read-only' || !manifest.verifiedAt || manifest.provenance?.resolution !== 'oracle') {
  throw new Error('Verified current testnet manifest required')
}
const aliases = { TradingFactory: 'MarketFactory', TradingVault: 'CollateralVault' }

export function currentConfig(template) {
  const config = structuredClone(template)
  config.name = 'eros-current-testnet'
  const chain = config.chains.find(c => c.id === 10143)
  if (!chain) throw new Error('Missing Monad testnet config')
  for (const source of chain.contracts) {
    if (source.name === 'TradingEngine') {
      source.address = manifest.markets.map(m => m.engine)
      source.start_block = Math.min(...manifest.markets.map(m => m.deployBlock))
    } else if (source.name === 'KeystoneForwarder') {
      // External shared simulation forwarder; not deployed by this stack or a frontend manifest pin.
      source.address = '0xB9F79d863261869B234c481D1f9A7af84AeAd192'
      source.start_block = manifest.contracts.ResolutionOracle.deployBlock
    } else {
      const pin = manifest.contracts[aliases[source.name] ?? source.name]
      if (!pin || /^0x0{40}$/i.test(pin.address) || !/^0x[0-9a-fA-F]{64}$/.test(pin.codehash)
        || pin.deployBlock > Number(manifest.verifiedAt.blockNumber)) throw new Error(`Invalid manifest pin: ${source.name}`)
      source.address = pin.address
      source.start_block = pin.deployBlock
    }
  }
  chain.start_block = Math.min(...chain.contracts.map(source => source.start_block))
  return config
}

export function checkCurrentConfig(write = false) {
  for (const name of ['config.yaml', 'config.fresh-testnet.yaml']) {
    const path = new URL(name, root)
    const existing = parse(readFileSync(path, 'utf8'))
    const expected = currentConfig(existing)
    if (write) writeFileSync(path, '# Current verified frontend deployment; generated pins: node scripts/current-config.mjs --write\n' + stringify(expected))
    else if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error(`${name} differs from current frontend manifest; run node scripts/current-config.mjs --write and regenerate Envio`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) checkCurrentConfig(process.argv.includes('--write'))
