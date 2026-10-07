/** Stage a verified frontend selection; --apply installs it with rollback backups. */
import { readFileSync, mkdirSync } from 'node:fs'
import { keccak256, stringToHex, type Address } from '../../frontend/node_modules/viem'
import { atomicWrite, artifact, client } from '../../oracle/e2e/src/fresh-testnet'
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest'
import { selectDeploymentManifests } from './manifest-selection'
const args = process.argv.slice(2), apply = args.includes('--apply')
const dirs = args.filter(arg => arg !== '--apply')
if (!dirs.length || dirs.some(d => !d.startsWith('artifacts/deployments/') || d.includes('..'))) throw Error('VERIFIED_DEPLOYMENT_DIRECTORIES_REQUIRED')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const old = toPublicManifest(read('frontend/src/config/public-manifest.json'))
const oldArchives = read('frontend/src/config/archived-deployments.json').map(toPublicManifest)
const metadata = read('frontend/src/config/market-metadata.json')
const calibrations = read('frontend/src/config/risk-calibrations.json') as any[]
const pc = client(process.env.MONAD_TESTNET_RPC!).public
if (await pc.getChainId() !== 10143) throw Error('WRONG_CHAIN')
const anchor = await pc.getBlock({ blockTag: 'finalized' })
const incoming = []
for (const d of dirs) {
  const report = read(d + '/market-verification.json'), source = read(d + '/source.json'), calibration = read(d + '/calibration.json')
  if (!report.passed || report.publicTransactions !== 7) throw Error('PUBLIC_DEPLOYMENT_NOT_VERIFIED')
  const manifest = toPublicManifest(report.manifest)
  if (manifest.markets.length !== 1) throw Error('ONE_VERIFIED_MARKET_PER_DEPLOYMENT_REQUIRED')
  if ((await pc.getBlock({ blockNumber: BigInt(manifest.verifiedAt!.blockNumber) })).hash !== manifest.verifiedAt!.blockHash) throw Error('DEPLOYMENT_ANCHOR_CHANGED')
  const current = manifest.markets[0]
  if (source.marketId !== current.marketId || source.sourceId !== current.sourceId) throw Error('SOURCE_IDENTITY_MISMATCH')
  const market = { ...current, name: `polymarket-${source.config.mapping.externalMarketId}-${current.engine.slice(2, 10).toLowerCase()}` }
  incoming.push(toPublicManifest({ ...manifest, markets: [market] }))
  metadata[market.name] = { title: report.title, short: report.title, source: 'Polymarket',
    category: source.config.category === 'politics' ? 'Politics' : source.config.category === 'sports' ? 'Sports' : 'Crypto', archived: false }
  if (!calibrations.some(c => c.profileHash === calibration.profileHash)) calibrations.push(calibration)
}
const selection = selectDeploymentManifests(old, oldArchives, incoming)
for (const archived of selection.archives) for (const market of archived.markets) {
  if (!metadata[market.name]) throw Error('PREVIOUS_MARKET_METADATA_MISSING')
  metadata[market.name] = { ...metadata[market.name], archived: true }
}
const selected = selection.selected, c = selected.contracts
const unique = new Map([...Object.values(c), ...selected.markets.map(m => ({ address: m.engine, codehash: m.codehash }))].map(v => [v.address.toLowerCase(), v]))
for (const v of unique.values()) {
  const r = await pc.call({ data: `0x73${v.address.slice(2)}3f60005260206000f3`, blockNumber: anchor.number })
  if (r.data?.toLowerCase() !== v.codehash.toLowerCase()) throw Error('RUNTIME_CHANGED')
}
for (const [contract, address, functionName, expected] of [
  ['MarketRegistry', c.MarketRegistry.address, 'factory', c.MarketFactory.address],
  ['MarketRegistry', c.MarketRegistry.address, 'oracle', c.ResolutionOracle.address],
  ['ResolutionOracle', c.ResolutionOracle.address, 'registry', c.MarketRegistry.address],
  ['MarketFactory', c.MarketFactory.address, 'registry', c.MarketRegistry.address],
  ['MarketFactory', c.MarketFactory.address, 'collateralVault', c.CollateralVault.address],
  ['CollateralVault', c.CollateralVault.address, 'token', c.CollateralToken.address],
] as const) {
  const actual = await pc.readContract({ address, abi: artifact(contract).abi, functionName, blockNumber: anchor.number })
  if ((actual as Address).toLowerCase() !== expected.toLowerCase()) throw Error('SHARED_CONTRACT_BINDING_CHANGED')
}
for (const m of selected.markets) {
  const [listing, hash, engine, vault] = await Promise.all([
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'listing', blockNumber: anchor.number }) as Promise<any>,
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'listingHash', blockNumber: anchor.number }),
    pc.readContract({ address: c.MarketFactory.address, abi: artifact('MarketFactory').abi, functionName: 'engineOf', args: [m.marketId], blockNumber: anchor.number }),
    pc.readContract({ address: m.engine, abi: artifact('RegistryBookRiskEngine').abi, functionName: 'collateralVault', blockNumber: anchor.number }),
  ])
  if (hash !== m.listingHash || listing.marketId !== m.marketId || listing.indexSourceId !== m.sourceId
    || (engine as Address).toLowerCase() !== m.engine.toLowerCase() || (vault as Address).toLowerCase() !== c.CollateralVault.address.toLowerCase()
    || listing.token.toLowerCase() !== c.CollateralToken.address.toLowerCase()
    || listing.registry.toLowerCase() !== c.MarketRegistry.address.toLowerCase()
    || listing.resolutionAuthority.toLowerCase() !== c.ResolutionOracle.address.toLowerCase()) throw Error('MARKET_BINDING_CHANGED')
}
if ((await pc.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw Error('VERIFICATION_REORGED')
const manifest = toPublicManifest({ ...selected, verifiedAt: { blockNumber: anchor.number.toString(), blockHash: anchor.hash },
  calibrationEvidence: keccak256(stringToHex(JSON.stringify([read('frontend/src/config/risk-calibration.json'), ...calibrations]))) })
const output = dirs[0] + '/frontend-selection'
mkdirSync(output, { recursive: true })
const files = { 'market-metadata.json': metadata, 'risk-calibrations.json': calibrations,
  'archived-deployments.json': selection.archives, 'public-manifest.json': manifest }
const report = { passed: true, status: 'staged', verifiedAt: manifest.verifiedAt, deployments: dirs,
  active: manifest.markets.map(m => m.engine), archived: selection.archives.flatMap(m => m.markets.map(v => v.engine)),
  note: 'Stop the frontend before --apply; restart or rebuild after all selection files are installed.' }
for (const [name, value] of Object.entries(files)) atomicWrite(output + '/' + name, value)
atomicWrite(output + '/report.json', report)
if (apply) {
  const previous = Object.fromEntries(Object.keys(files).map(name => [name, read('frontend/src/config/' + name)]))
  atomicWrite(output + '/previous-selection.json', previous)
  atomicWrite(output + '/report.json', { ...report, status: 'applying' })
  try {
    for (const [name, value] of Object.entries(files)) atomicWrite('frontend/src/config/' + name, value)
    atomicWrite(output + '/report.json', { ...report, status: 'applied' })
  } catch (error) {
    for (const [name, value] of Object.entries(previous)) atomicWrite('frontend/src/config/' + name, value)
    atomicWrite(output + '/report.json', { ...report, status: 'rolled-back' })
    throw error
  }
}
console.log(JSON.stringify({ selected: apply, staged: true, output, markets: manifest.markets.length, anchor: anchor.number.toString() }))
