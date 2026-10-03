// Task O37.2: records the events the handler tests replay. A local deploy of the whole stack (the keeper's O31.4 anvil
// stack: DeployUmaSandbox, DeployOracle, CreateTrustSet and FundTreasury through the Timelock) and two markets taken
// through every path an entity comes from, by the real services' code where they exist:
//   A  Layer 1: halt, request, the CRE report through the sim forwarder (ReportProcessed), assert (OOv3 AssertionMade,
//      the adapter, the treasury's bond), the watchdog's heartbeat and its dispute with the float, sync, the sandbox
//      DVM answers "untruthful" (PricePushed), finalize rejects the assertion (bond lost), the dispute is closed, and
//      the market is voided at its voidDeadline.
//   B  Layer 2: escalated, the panel runner's signed result routes to Review, two committee members propose and
//      submit through the console (REVIEWED), assert, liveness passes, finalize (Final, bond returned).
// Every log of the chain is written with its block and transaction to test/fixtures/recorded/events.json, with the
// local addresses by contract name (the tests map them onto config.yaml's).
//
//   cd oracle/indexer && bun test scripts/record.test.ts       (needs anvil and forge; not part of `pnpm test`)
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, encodeFunctionData, type Hex, parseAbi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { loadGas, MarketRegistryAbi, modelIdHash } from '../../packages/oracle-sdk/src'
import { calibratorHash, loadPrompts, placeholderMaps } from '../../services/panel-runner/src'
import { takeSnapshot } from '../../services/snapshotter/src'
import { viemCaseChain } from '../../services/committee-console/src/backend/chain'
import { EvidenceStore } from '../../services/committee-console/src/backend/store'
import { CommitteeConsole } from '../../services/committee-console/src/ui/console'
import { MEMBER_KEYS } from '../../services/committee-console/test/fake'
import { deployStack, dvmAnswer, fund, listExample, now, reportL1, resolution, rpc, venueStatus, warpTo } from '../../services/keeper/test/fork/stack'
import { ATTESTOR, makeRunner, MODELS, runPanel, startEvidence, toL2Pending } from '../../services/panel-runner/test/fork/harness'

const OUT = new URL('../test/fixtures/recorded/', import.meta.url).pathname
const ORACLE_ABI = parseAbi([
  'function haltScheduled(bytes32 id) returns (bool)',
  'function requestResolution(bytes32 id) returns (bool)',
  'function assertProposal(bytes32 id) returns (bool)',
  'function syncAssertion(bytes32 id) returns (bool)',
  'function finalizeMarket(bytes32 id) returns (uint8)',
  'function voidMarket(bytes32 id) returns (bool)',
  'function watchdogHeartbeat()',
])
const TREASURY_ABI = parseAbi(['function disputeViaVenue(bytes32 id)', 'function closeDispute(bytes32 assertionId) returns (bool)', 'function skim() returns (uint256)'])
const BUFFER_SECS = 60n // the example pack's FeedSpec bufferSecs
const sports = loadPrompts().find((p) => p.category === 'sports')!

test('record the lifecycle events', async () => {
  const ev = startEvidence()
  const watchdogKey = generatePrivateKey()
  const members = MEMBER_KEYS.map((k) => privateKeyToAccount(k))
  const s = await deployStack(20_000 + ((process.pid + 29) % 20_000), { attestor: ATTESTOR, committee: members.map((m) => m.address), watchdog: privateKeyToAccount(watchdogKey).address })
  try {
    const c = s.deployments.contracts
    const oracle = c.ResolutionOracle.address as Address
    const treasury = c.BondTreasury.address as Address
    const send = async (key: Hex, to: Address, data: Hex) => {
      await fund(s, privateKeyToAccount(key).address)
      const hash = (await rpc(s.rpcUrl, 'eth_sendRawTransaction', [await sign(key, to, data)])) as Hex
      const r = await s.pc.waitForTransactionReceipt({ hash })
      expect(r.status).toBe('success')
      return r
    }
    const sign = async (key: Hex, to: Address, data: Hex) => {
      const a = privateKeyToAccount(key)
      const nonce = await s.pc.getTransactionCount({ address: a.address, blockTag: 'pending' })
      return a.signTransaction({ to, data, nonce, gas: 3_000_000n, gasPrice: 2_000_000_000n, chainId: 31337, type: 'legacy' })
    }
    const anyone = generatePrivateKey()
    const callOracle = (fn: (typeof ORACLE_ABI)[number]['name'], id?: Hex, key = anyone) => send(key, oracle, encodeFunctionData({ abi: ORACLE_ABI, functionName: fn, args: id ? [id] : [] } as never))

    // ---- A: Layer 1, disputed by the watchdog, rejected by the DVM, voided
    const idA = await listExample(s)
    const coreA = await s.pc.readContract({ address: c.MarketRegistry.address as Address, abi: MarketRegistryAbi, functionName: 'getMarketCore', args: [idA] })
    await warpTo(s, coreA.tau)
    await callOracle('haltScheduled', idA)
    await warpTo(s, coreA.tau + BUFFER_SECS)
    await callOracle('requestResolution', idA)
    await reportL1(s, idA, 1, coreA.tau + BUFFER_SECS)
    await callOracle('watchdogHeartbeat', undefined, watchdogKey)
    await callOracle('assertProposal', idA)
    await send(watchdogKey, treasury, encodeFunctionData({ abi: TREASURY_ABI, functionName: 'disputeViaVenue', args: [idA] }))
    await callOracle('syncAssertion', idA)
    expect((await resolution(s, idA)).state).toBe(8)
    const disputedAssertion = (await resolution(s, idA)).assertionId as Hex
    await dvmAnswer(s, false)
    await callOracle('finalizeMarket', idA)
    await send(anyone, treasury, encodeFunctionData({ abi: TREASURY_ABI, functionName: 'closeDispute', args: [disputedAssertion] }))
    await send(anyone, treasury, encodeFunctionData({ abi: TREASURY_ABI, functionName: 'skim' }))

    // ---- B: Layer 2 → Review → the committee's REVIEWED proposal → Final
    // the panel harness's pinned market (its models, prompt and calibration), under a second market id
    const idB = await listExample(s, (pack) => {
      pack.marketInput.marketId = `0x${'b2'.repeat(32)}`
      pack.marketInput.ai.modelIdHashes = MODELS.map(modelIdHash)
      pack.marketInput.ai.promptHash = sports.promptHash
      pack.marketInput.ai.calibratorHash = calibratorHash(placeholderMaps(MODELS))
      pack.marketInput.ai.categoryId = sports.categoryId
    })
    const snapshotDir = mkdtempSync(join(tmpdir(), 'indexer-record-'))
    const runner = await makeRunner(s, ev, snapshotDir)
    await toL2Pending(s, idB)
    expect((await runPanel(s, runner)).routedTo).toBe(5)
    const relayer = generatePrivateKey()
    await fund(s, privateKeyToAccount(relayer).address)
    const chain = viemCaseChain({ rpcUrl: s.rpcUrl, deployments: s.deployments, relayerKey: relayer, fromBlock: 0n })
    const store = new EvidenceStore(snapshotDir)
    const reviewer = (i: number) =>
      new CommitteeConsole({ chain, store, gas: loadGas(), takeSnapshot: (req) => takeSnapshot(req, { fetchFn: ev.fetch }), account: members[i], dataDir: mkdtempSync(join(tmpdir(), `indexer-committee-${i}-`)) })
    const { path } = await reviewer(0).propose(idB, 'YES', 'Final score 3-1: the home team scored more than 2 goals, so YES under the rules.')
    await reviewer(1).sign(path, 'YES')
    await s.pc.waitForTransactionReceipt({ hash: await reviewer(1).submit(path) })
    await callOracle('assertProposal', idB)
    expect((await resolution(s, idB)).state).toBe(7)
    const st = await venueStatus(s, idB)
    await warpTo(s, st.expiresAt + 1n)
    await callOracle('finalizeMarket', idB)
    expect((await resolution(s, idB)).state).toBe(10)

    // ---- A reaches its voidDeadline
    const rA = await resolution(s, idA)
    await warpTo(s, BigInt(rA.voidDeadline) + 1n)
    await callOracle('voidMarket', idA)
    expect((await resolution(s, idA)).state).toBe(10)

    // ---- every log, with its block and transaction
    const logs = (await rpc(s.rpcUrl, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }])) as any[] // not getBlockNumber: viem caches it
    const blocks = new Map<string, { number: number; timestamp: number; hash: string }>()
    const froms = new Map<string, string>()
    for (const l of logs) {
      if (!blocks.has(l.blockNumber)) {
        const b = await s.pc.getBlock({ blockNumber: BigInt(l.blockNumber) })
        blocks.set(l.blockNumber, { number: Number(b.number), timestamp: Number(b.timestamp), hash: b.hash })
      }
      if (!froms.has(l.transactionHash)) froms.set(l.transactionHash, (await s.pc.getTransaction({ hash: l.transactionHash })).from)
    }
    const addresses = {
      ResolutionOracle: oracle, MarketRegistry: c.MarketRegistry.address, BondTreasury: treasury, UmaAdapter: c.UmaAdapter.address,
      OptimisticOracleV3: s.deployments.uma.oov3, ErosSandboxOracle: s.deployments.uma.sandboxOracle,
      KeystoneForwarder: (await s.pc.readContract({ address: oracle, abi: parseAbi(['function simForwarder() view returns (address)']), functionName: 'simForwarder' })) as Address,
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'events.json'), JSON.stringify({
      recordedAt: new Date((Number(await now(s))) * 1000).toISOString(), chainId: 31337, markets: { A: idA, B: idB }, disputedAssertion, addresses,
      logs: logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: Number(l.logIndex), transactionHash: l.transactionHash, from: froms.get(l.transactionHash), block: blocks.get(l.blockNumber) })),
    }, null, 1) + '\n')
    console.log(`${logs.length} logs → ${join(OUT, 'events.json')}`)
  } finally {
    await s.stop()
    ev.stop()
  }
}, 900_000)
