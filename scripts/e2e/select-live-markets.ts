/** Select only verified public deployments; retain old owners' portfolio access. */
import { readFileSync, mkdirSync } from 'node:fs'
import { keccak256, stringToHex, type Address, type Hex } from '../../frontend/node_modules/viem'
import { atomicWrite, artifact, client } from '../../oracle/e2e/src/fresh-testnet'
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest'
const dirs = process.argv.slice(2)
if (!dirs.length || dirs.some(d => !d.startsWith('artifacts/deployments/'))) throw Error('VERIFIED_DEPLOYMENT_DIRECTORIES_REQUIRED')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const old = toPublicManifest(read('frontend/src/config/public-manifest.json'))
const metadata = read('frontend/src/config/market-metadata.json')
const calibrations = read('frontend/src/config/risk-calibrations.json') as any[]
const pc = client(process.env.MONAD_TESTNET_RPC!).public
if (await pc.getChainId() !== 10143) throw Error('WRONG_CHAIN')
const anchor = await pc.getBlock({ blockTag: 'finalized' })
const markets = [...old.markets]
for (const d of dirs) {
  const report = read(d + '/market-verification.json'), source = read(d + '/source.json'), calibration = read(d + '/calibration.json')
  if (!report.passed || report.publicTransactions !== 7) throw Error('PUBLIC_DEPLOYMENT_NOT_VERIFIED')
  const manifest = toPublicManifest(report.manifest)
  if ((await pc.getBlock({ blockNumber: BigInt(manifest.verifiedAt!.blockNumber) })).hash !== manifest.verifiedAt!.blockHash) throw Error('DEPLOYMENT_ANCHOR_CHANGED')
  for (const [key, contract] of Object.entries(old.contracts)) {
    if (manifest.contracts[key]?.address.toLowerCase() !== contract.address.toLowerCase() || manifest.contracts[key]?.codehash !== contract.codehash) throw Error('SHARED_DEPLOYMENT_MISMATCH')
  }
  const current = manifest.markets[0]
  const market = { ...current, name: source.deploymentRevision
    ? `polymarket-${source.config.mapping.externalMarketId}-${current.engine.slice(2, 10).toLowerCase()}`
    : `polymarket-${source.config.mapping.externalMarketId}` }
  for (const previous of markets) {
    if (previous.sourceId === market.sourceId && previous.engine.toLowerCase() !== market.engine.toLowerCase()) {
      if (!metadata[previous.name]) throw Error('PREVIOUS_MARKET_METADATA_MISSING')
      metadata[previous.name] = { ...metadata[previous.name], archived: true }
    }
  }
  const index = markets.findIndex(m => m.engine.toLowerCase() === market.engine.toLowerCase())
  if (index < 0) markets.push(market); else markets[index] = market
  metadata[market.name] = { title: report.title,
    short: source.config.mapping.externalMarketId === '562831' ? 'Republican control · Nov 3'
      : source.config.mapping.externalMarketId === '562793' ? 'Democratic Senate · Nov 3' : report.title,
    source: 'Polymarket', category: ['562831', '562793'].includes(source.config.mapping.externalMarketId) ? 'Politics' : undefined,
    archived: false }
  if (!calibrations.some(c => c.profileHash === calibration.profileHash)) calibrations.push(calibration)
}
for (const v of [...Object.values(old.contracts), ...markets.map(m => ({ address: m.engine, codehash: m.codehash }))]) {
  const r = await pc.call({ data: `0x73${v.address.slice(2)}3f60005260206000f3`, blockNumber: anchor.number })
  if (r.data?.toLowerCase() !== v.codehash.toLowerCase()) throw Error('RUNTIME_CHANGED')
}
for (const m of markets) {
  const [listing, hash, engine, vault] = await Promise.all([
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'listing', blockNumber: anchor.number }) as Promise<any>,
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'listingHash', blockNumber: anchor.number }),
    pc.readContract({ address: old.contracts.MarketFactory.address, abi: artifact('MarketFactory').abi, functionName: 'engineOf', args: [m.marketId], blockNumber: anchor.number }),
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'collateralVault', blockNumber: anchor.number }),
  ])
  if (hash !== m.listingHash || listing.marketId !== m.marketId || listing.indexSourceId !== m.sourceId
    || (engine as Address).toLowerCase() !== m.engine.toLowerCase() || (vault as Address).toLowerCase() !== old.contracts.CollateralVault.address.toLowerCase()
    || listing.registry.toLowerCase() !== old.contracts.MarketRegistry.address.toLowerCase()
    || listing.resolutionAuthority.toLowerCase() !== old.contracts.ResolutionOracle.address.toLowerCase()) throw Error('MARKET_BINDING_CHANGED')
  if (!metadata[m.name]) throw Error('MARKET_METADATA_MISSING')
}
if ((await pc.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw Error('VERIFICATION_REORGED')
const manifest = toPublicManifest({ ...old, markets, verifiedAt: { blockNumber: anchor.number.toString(), blockHash: anchor.hash },
  calibrationEvidence: keccak256(stringToHex(JSON.stringify([read('frontend/src/config/risk-calibration.json'), ...calibrations]))) })
const output = 'artifacts/deployments/live-markets-20261006'
mkdirSync(output, { recursive: true })
atomicWrite(output + '/public-manifest.json', manifest)
atomicWrite(output + '/frontend-selection.json', { passed: true, verifiedAt: manifest.verifiedAt, deployments: dirs,
  active: markets.filter(m => !metadata[m.name].archived).map(m => m.engine), archived: markets.filter(m => metadata[m.name].archived).map(m => m.engine) })
atomicWrite('frontend/src/config/market-metadata.json', metadata)
atomicWrite('frontend/src/config/risk-calibrations.json', calibrations)
atomicWrite('frontend/src/config/public-manifest.json', manifest)
console.log(JSON.stringify({ selected: true, markets: markets.length, anchor: anchor.number.toString() }))
