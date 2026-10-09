import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseEther, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem'
import { artifact, atomicWrite, client, executePlan, MODE, operation, runtimeMatches, type Plan, type Step } from './fresh-testnet'
import { rulesHash } from '../../../packages/pricefeed/src/rules'
import { calibratorHash } from '../../services/panel-runner/src/calibration'
import { toPublicManifest } from '../../packages/oracle-sdk/src/trading-manifest'
import { evaluateResponse, type FeedSpec } from '../../packages/feedspec/src'
import { testnetMarketCapacity } from './market-capacity'

const ROOT = resolve(import.meta.dir, '../../..'), RPC = process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz'
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const hash = (value: string) => keccak256(stringToHex(value))
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n'
type MarketPlan = Plan & { market: { engine: Address; marketId: Hex; title: string; source: any; pack: any; riskParams: any; profileHash: Hex; calibrationEvidence: Hex } }

export async function prepareMarket(directory: string, sourcePath: string) {
  if (existsSync(resolve(directory, 'market-plan.json'))) throw new Error('MARKET_PLAN_EXISTS')
  const base = read(resolve(directory, 'base-plan.json')) as Plan
  const baseReport = read(resolve(directory, 'base-verification.json'))
  if (!baseReport.passed) throw new Error('VERIFIED_BASE_REQUIRED')
  const pc = client(RPC).public, block = await pc.getBlock({ blockTag: 'finalized' }), a = base.addresses
  const source = read(sourcePath), mapping = source.config.mapping
  const category = source.config.category
  if (!['crypto', 'politics', 'sports'].includes(category)) throw new Error('INVALID_SOURCE_CATEGORY')
  if (!/^[0-9]+$/.test(mapping.externalMarketId)) throw new Error('INVALID_EXTERNAL_MARKET_ID')
  let reference: string
  if (process.env.EROS_SOURCE_CAPTURE_FILE) {
    const capture = read(process.env.EROS_SOURCE_CAPTURE_FILE)
    if (capture.url !== `https://gamma-api.polymarket.com/markets/${mapping.externalMarketId}`
      || !Number.isSafeInteger(capture.receivedAtMs) || Date.now() < capture.receivedAtMs
      || Date.now() - capture.receivedAtMs > 90000 || typeof capture.body !== 'string') throw new Error('STALE_SOURCE_CAPTURE')
    reference = capture.body
  } else {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/${mapping.externalMarketId}`, { redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('SOURCE_METADATA_UNAVAILABLE')
    reference = await response.text()
  }
  if (reference.length > 131072) throw new Error('SOURCE_METADATA_TOO_LARGE')
  const metadata = JSON.parse(reference)
  const outcomes = typeof metadata.outcomes === 'string' ? JSON.parse(metadata.outcomes) : metadata.outcomes
  const tokens = typeof metadata.clobTokenIds === 'string' ? JSON.parse(metadata.clobTokenIds) : metadata.clobTokenIds
  const yes = outcomes.findIndex((s: string) => s === mapping.outcomeLabel)
  if (String(metadata.id) !== mapping.externalMarketId || metadata.conditionId !== mapping.conditionId
    || outcomes.length !== 2 || new Set(outcomes).size !== 2 || yes < 0
    || tokens[yes] !== mapping.outcomeTokenId || metadata.question !== source.question || metadata.description !== source.description
    || metadata.closed || Math.floor(Date.parse(metadata.endDate) / 1000) !== Number(source.scheduledT)) throw new Error('SOURCE_IDENTITY_CHANGED')
  // The deployed registry also enforces a 30-day-minus-one-hour maximum.
  // Changing a script option cannot extend that immutable protocol boundary.
  if (BigInt(source.scheduledT) < block.timestamp + 25n * 3600n || BigInt(source.scheduledT) > block.timestamp + 29n * 86400n) throw new Error('SOURCE_HORIZON_CHANGED')
  const nonce = await pc.getTransactionCount({ address: base.deployer, blockTag: 'pending' })
  if (nonce !== await pc.getTransactionCount({ address: base.deployer, blockTag: 'latest' })) throw new Error('PENDING_DEPLOYER_TRANSACTION')
  const factoryNonce = await pc.getTransactionCount({ address: a.MarketFactory, blockTag: 'latest' })
  const engine = getContractAddress({ from: a.MarketFactory, nonce: BigInt(factoryNonce) })
  const revision = source.deploymentRevision
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-z0-9-]{1,32}$/.test(revision))) throw new Error('INVALID_DEPLOYMENT_REVISION')
  const marketId = hash(revision
    ? `EROS_MONAD_TESTNET_MARKET_V2:${a.MarketRegistry}:${mapping.conditionId}:${mapping.outcomeTokenId}:${revision}`
    : `EROS_MONAD_TESTNET_MARKET_V1:${a.MarketRegistry}:${mapping.conditionId}:${mapping.outcomeTokenId}`)
  const capacity = testnetMarketCapacity(BigInt(source.depthNLots))
  const rules = `Monad testnet mirror of Polymarket market ${mapping.externalMarketId}, condition ${mapping.conditionId}. `
    + `YES if the finalized binary payout for outcome ${JSON.stringify(mapping.outcomeLabel)}, token ${mapping.outcomeTokenId}, is 1; NO if it is 0. A fractional/split or unavailable payout must not be treated as NO; the oracle review/invalid process applies. `
    + 'The API must report umaResolutionStatus=resolved. Merely closing trading is insufficient. Test collateral, synthetic risk calibration and the owner-controlled UMA testnet sandbox apply. '
    + `External event description hash: ${hash(source.description)}. Source: https://gamma-api.polymarket.com/markets/${mapping.externalMarketId}.`
  const sourceRules = { ...source.rules, marketId, erosRulesHash: hash(rules) }
  const mappedSource = { ...source, mode: 'MONAD_TESTNET_EXTERNAL_SOURCE', chainId: 10143, marketId,
    indexSigner: base.roles.INDEX_SIGNER, erosRulesHash: hash(rules), sourceRulesHash: rulesHash(sourceRules), rules: sourceRules,
    config: { ...source.config, configVersion: 'monad-integrated-demo-1', requiredFeedUntil: source.scheduledT },
    resolution: { provider: 'Polymarket Gamma', yesIndex: yes, statusRequired: 'resolved', fractionalPayout: 'review/invalid; no L1 binary report' } }
  const feed: FeedSpec = { urlTemplate: 'https://gamma-api.polymarket.com/markets/{id}', urlParam: mapping.externalMarketId,
    authRef: zeroHash, finalPath: 'umaResolutionStatus', finalValue: 'resolved', valuePath: `outcomePrices[${yes}]`,
    valueType: 1, decimals: 0, op: 0, target: '1', bufferSecs: 60, l1TimeoutSecs: 300 }
  if (evaluateResponse(feed, 200, reference, Buffer.byteLength(reference)).status !== 'NOT_READY') throw new Error('SOURCE_ALREADY_RESOLVED')
  const maps = read(resolve(ROOT, 'oracle/validation/calibration/maps.json'))
  const models = maps.map((m: {model: string}) => m.model)
  const example = read(resolve(ROOT, 'oracle/listings/example/pack.json'))
  const marketInput = { marketId, question: source.question, rules, claimTemplate: example.marketInput.claimTemplate,
    windowStart: block.timestamp, windowEnd: BigInt(source.scheduledT), tau: BigInt(source.scheduledT), groupId: zeroHash, groupExclusive: false,
    hasFeed: true, feed, allowList: ['gamma-api.polymarket.com', 'clob.polymarket.com'],
    ai: { allowListPtr: zeroAddress, modelIdHashes: models.map(hash),
      promptHash: hash(readFileSync(resolve(ROOT, `oracle/services/panel-runner/src/prompts/templates/${category}.txt`), 'utf8')),
      calibratorHash: calibratorHash(maps), categoryId: hash(category), highConfBps: 9100 },
    uma: { bondCurrency: a.TestUSDC, minBond: 2_000000n, bondBps: 1112, livenessL1: 120n, livenessAuto: 120n, livenessReviewed: 300n, claimTemplatePtr: zeroAddress },
    l2DeadlineSecs: 600, voidSecs: 30 * 86400, monitor: base.roles.KEEPER, oiCapLots: capacity.oiCapLots,
    dryRunHash: hash(reference), ambiguityLogHash: hash('Testnet mirror uses resolved binary Polymarket payout; fractional outcomes require review. Synthetic risk and placeholder AI calibration are separately labeled.') }
  const listing = { marketId: zeroHash, token: a.TestUSDC, registry: zeroAddress, resolutionAuthority: zeroAddress, monitor: zeroAddress,
    governance: a.Timelock, listedAt: 0n, scheduledT: 0n, sourceHash: zeroHash, rulesHash: zeroHash,
    invalidRule: { fallbackListed: false, captureGraceSecs: 0n, fallbackPriceWad: 0n, voidSecs: 0n },
    template: 0, deploymentCapX: 5n, maxTraders: 1024, indexSourceId: source.sourceId, indexSigner: base.roles.INDEX_SIGNER,
    indexRulesHash: mappedSource.sourceRulesHash, depthNLots: BigInt(source.depthNLots), maxSpreadWad: BigInt(source.maxSpreadWad),
    bootstrapBandWad: 50_000_000_000_000_000n, minOrderLots: 1n, maxOrderLots: 4_294_967_295n, maxLiqLotsPerBlock: 100_000n, fundingEnabled: false }
  // Exact existing deterministic fixture parameters, explicitly synthetic.
  // Long-dated events must renew calibration; the test fixture is never treated
  // as empirical calibration valid until a multi-year election resolves.
  const calibrationEnd = block.timestamp + 30n * 86400n < BigInt(source.scheduledT)
    ? block.timestamp + 30n * 86400n : BigInt(source.scheduledT)
  const envelope = { hSecs: [30n * 86400n], sigmaWad: [0n], validFrom: block.timestamp, validUntil: calibrationEnd }
  const riskParams = { h0Secs: 300n, absorptionClaimsPerMin: 1000n, queueSecs: 0n, hazard0WadPerDay: 100_000_000_000_000n,
    hazard1WadPerDay: 100_000_000_000_000n, epsilonWad: 10_000_000_000_000_000n, gammaWad: 1_500_000_000_000_000_000n,
    sWad: 5_000_000_000_000_000n, lambdaWadPerClaim: 1_000_000_000_000n, template: 0, calibrated: true, deploymentCapX: 5n,
    realized: envelope, templateEnv: envelope }
  const profileInputs = artifact('RegistryBookRiskEngine').abi.find((f: any) => f.name === 'profileHashOf').inputs
  const profileHash = keccak256(encodeAbiParameters(profileInputs, [riskParams]))
  const calibration = { kind: 'fixture', description: 'RiskFixture.profile(5,true), zero empirical envelopes; bounded validity/horizon as in the deterministic leveraged integration.', riskParams, profileHash }
  const steps: Step[] = []
  const call = (name: string, contract: string, to: Address, functionName: string, args: unknown[], extra: Partial<Step> = {}) =>
    steps.push({ name, nonce: nonce + steps.length, to, data: encodeFunctionData({ abi: artifact(contract).abi, functionName, args }), ...extra })
  call('market:list', 'MarketRegistry', a.MarketRegistry, 'createMarket', [marketInput, listing, '0x'], { gasMarginBps: 500 })
  const vault = baseReport.contracts.CollateralVault.address as Address
  call('reserve:faucet', 'TestUSDC', a.TestUSDC, 'mint', [base.deployer, 100_000_000000n])
  call('reserve:approve', 'TestUSDC', a.TestUSDC, 'approve', [vault, 100_000_000000n])
  call('reserve:deposit', 'CollateralVault', vault, 'deposit', [100_000_000000n])
  call('reserve:allocate', 'CollateralVault', vault, 'allocate', [engine, 100_000_000000n, true])
  const execution = operation([
    { to: engine, value: 0n, data: encodeFunctionData({ abi: artifact('RegistryBookRiskEngine').abi, functionName: 'stageRiskParams', args: [riskParams] }) },
    { to: engine, value: 0n, data: encodeFunctionData({ abi: artifact('RegistryBookRiskEngine').abi, functionName: 'activateMarket', args: [] }) },
  ], `eros-fresh-testnet:${marketId}:activate`)
  call('governance:propose-market', 'Timelock', a.Timelock, 'propose', [MODE, execution, 300n])
  call('governance:execute-market', 'Timelock', a.Timelock, 'execute', [MODE, execution], { waitSeconds: 300 })
  const plan: MarketPlan = { ...base, schema: 'eros-fresh-testnet-market/1', startNonce: nonce, preparedBlock: block.number.toString(),
    preparedBlockHash: block.hash, steps, maxTotalGasCostWei: parseEther('5').toString(),
    market: { engine, marketId, title: source.question, source: mappedSource, pack: { marketInput, engineListing: listing, engineInit: '0x' }, riskParams, profileHash, calibrationEvidence: hash(json(calibration)) } }
  atomicWrite(resolve(directory, 'market-plan.json'), plan)
  atomicWrite(resolve(directory, 'source.json'), mappedSource)
  atomicWrite(resolve(directory, 'calibration.json'), calibration)
  atomicWrite(resolve(directory, 'panel-config.json'), { models, maps, source: 'placeholder maps below confidence gate; not empirical AI calibration', automaticGateValidated: false })
  writeFileSync(resolve(directory, 'polymarket-reference.json'), reference, { mode: 0o600, flag: 'wx' })
  console.log(json({ status: 'prepared', marketId, engine, question: source.question, steps: steps.length, cap: 5, sourceId: source.sourceId }))
}

async function verify(raw: Plan, pc: ReturnType<typeof client>['public'], journal: any, directory: string) {
  const p = raw as MarketPlan, m = p.market, a = p.addresses
  const block = await pc.getBlock({ blockTag: journal.broadcast ? 'finalized' : 'latest' })
  const readAt = (name: string, address: Address, functionName: string, args: unknown[] = []) => pc.readContract({ abi: artifact(name).abi, address, functionName, args, blockNumber: block.number }) as Promise<any>
  const [listing, listingHash, vault, active, reserve, code, actualEngine, profileHash, core, pricingWindows] = await Promise.all([
    readAt('RegistryBookRiskEngine', m.engine, 'listing'), readAt('RegistryBookRiskEngine', m.engine, 'listingHash'),
    readAt('RegistryBookRiskEngine', m.engine, 'collateralVault'), readAt('RegistryBookRiskEngine', m.engine, 'active'),
    readAt('RegistryBookRiskEngine', m.engine, 'reserve'), pc.getCode({ address: m.engine, blockNumber: block.number }),
    readAt('MarketFactory', a.MarketFactory, 'engineOf', [m.marketId]), readAt('RegistryBookRiskEngine', m.engine, 'profileHashOf', [m.riskParams]),
    readAt('MarketRegistry', a.MarketRegistry, 'getMarketCore', [m.marketId]),
    readAt('RegistryBookRiskEngine', m.engine, 'pricingWindows'),
  ])
  if (await pc.getChainId() !== 10143 || pricingWindows.map(String).join(',') !== '60,60,180,30') {
    throw new Error('TESTNET_PRICING_WINDOWS_MISMATCH')
  }
  const base = read(resolve(directory, journal.broadcast ? 'base-verification.json' : 'rehearsal-verification.json'))
  if (!active || !code || !runtimeMatches(code, artifact('RegistryBookRiskEngine').deployedBytecode)
    || actualEngine.toLowerCase() !== m.engine.toLowerCase() || vault.toLowerCase() !== base.contracts.CollateralVault.address.toLowerCase()
    || listing.marketId !== m.marketId || listing.registry.toLowerCase() !== a.MarketRegistry.toLowerCase()
    || listing.resolutionAuthority.toLowerCase() !== a.ResolutionOracle.toLowerCase() || listing.indexSourceId !== m.source.sourceId
    || listing.indexRulesHash !== m.source.sourceRulesHash || listing.indexSigner.toLowerCase() !== p.roles.INDEX_SIGNER.toLowerCase()
    || listing.rulesHash !== m.source.erosRulesHash || listing.deploymentCapX !== 5n || listing.fundingEnabled
    || reserve[1] !== 100_000n * 10n ** 24n || profileHash !== m.profileHash
    || core.oiCapLots !== BigInt(m.pack.marketInput.oiCapLots)
    || core.oiCapLots <= listing.depthNLots) throw new Error('INTEGRATED_MARKET_VERIFICATION_FAILED')
  const inputs = artifact('RegistryBookRiskEngine').abi.find((f: any) => f.name === 'listing').outputs
  if (keccak256(encodeAbiParameters(inputs, [listing])) !== listingHash) throw new Error('LISTING_HASH_MISMATCH')
  const caps = await readAt('RegistryBookRiskEngine', m.engine, 'leverageCaps')
  const identity = { name: 'polymarket-demo', engine: m.engine, marketId: m.marketId, sourceId: m.source.sourceId,
    listingHash, codehash: keccak256(code), deployBlock: Number(journal.steps[0].receipt.blockNumber),
    deploymentCapX: 5, template: 0, maxLiqLotsPerBlock: '100000', fundingEnabled: false }
  const manifest = toPublicManifest({ manifestVersion: 1, scope: 'testnet-read-only', chainId: 10143, sourceCommit: p.sourceCommit,
    riskScenario: 'leveraged-fixture', sourceMode: 'polymarket', calibrationEvidence: m.calibrationEvidence,
    provenance: { collateral: 'testnet', index: 'external', calibration: 'synthetic', resolution: 'oracle' },
    verifiedAt: { blockNumber: block.number.toString(), blockHash: block.hash }, contracts: base.contracts, markets: [identity], accounts: {} })
  if ((await pc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('VERIFICATION_BLOCK_REORGED')
  return { passed: true, publicTransactions: journal.broadcast ? journal.steps.length : 0, manifest, listing, caps,
    pricingWindows: { indexSeconds: Number(pricingWindows[0]), perpSeconds: Number(pricingWindows[1]),
      basisSeconds: Number(pricingWindows[2]), carryLimitSeconds: Number(pricingWindows[3]) },
    capacity: { oiCapLots: core.oiCapLots, depthNLots: listing.depthNLots, samplingHeadroomLots: core.oiCapLots - listing.depthNLots },
    profileHash, title: m.title, oracleDelivery: 'CRE simulation; production network workflow not deployed', uma: 'owner-controlled testnet sandbox',
    publication: 'configured external source; continuous operators require service activation' }
}

if (import.meta.main) {
  const [command, dir, input] = process.argv.slice(2), directory = resolve(dir ?? '')
  try {
    if (!dir) throw new Error('RUN_DIRECTORY_REQUIRED')
    if (command === 'prepare') await prepareMarket(directory, resolve(input))
    else if (command === 'rehearse' || command === 'broadcast') {
      const plan = read(resolve(directory, 'market-plan.json')) as MarketPlan
      if (command === 'broadcast') {
        const rehearsal = read(resolve(directory, 'market-rehearsal-journal.json'))
        if (rehearsal.status !== 'passed' || rehearsal.planHash !== hash(json(plan))) throw new Error('PASSING_MARKET_REHEARSAL_REQUIRED')
      }
      const lock = resolve(directory, 'execution.lock'); mkdirSync(lock)
      try { await executePlan(plan, directory, command === 'broadcast' ? RPC : input, command === 'broadcast', 'market', (p,c,j) => verify(p,c,j,directory)) }
      finally { rmSync(lock, { recursive: true }) }
    } else throw new Error('UNKNOWN_COMMAND')
  } catch (error) {
    const e = error as Error
    console.error(/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message) ? e.message : e.name)
    process.exitCode = 1
  }
}
