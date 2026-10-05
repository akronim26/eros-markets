// Local Solidity equivalents of the real-engine oracle paths. No public stack imports,
// keys, RPC URL, price fetch, signing or public broadcast are involved.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_SCENARIOS = {
  E1: ['testL1ProductionShapedMetadataAndReplayProtectionWithRealEngine'],
  E2: ['testDisputedAssertionWaitsThenPaysOnlyAfterResolutionAndPreparation'],
  E3: ['testRejectedYesThenAcceptedNoDoesNotPrematurelySettleEngine'],
  E4: ['testBothRejectedProduceInvalidNotAnUnbackedPayout', 'testEarlyInvalidWaitsForScheduledWindowAndGrace'],
  E5: ['testPermissionlessResolutionUsesCallerBondAndRealClaims'],
  E6: ['testRealFillEarlyYesFinalityAndOwnerClaimsBeforeT'],
  E7: ['testVoidWithUnansweredDisputeSettlesInvalidAndRemainsClaimable'],
  E8: ['testFifteenRealMarketsShareTAndCompleteBoundedClaims'],
  E9: ['testExclusiveGroupCannotResolveTwoRealMarketsYes'],
} as const

type TestResult = { status: string; reason?: string }
export function summarizeCoverage(results: Record<string, { test_results?: Record<string, TestResult> }>) {
  const tests = Object.entries(results).flatMap(([suite, value]) => Object.entries(value.test_results ?? {}).map(([name, result]) => ({ suite, name: name.split('(')[0], ...result })))
  const scenarios = Object.fromEntries(Object.entries(LOCAL_SCENARIOS).map(([id, names]) => [id, {
    scope: 'local-contract-equivalent',
    tests: names.map(name => ({ name, results: tests.filter(test => test.name === name) })),
    passed: names.every(name => tests.filter(test => test.name === name).length === 1 && tests.find(test => test.name === name)?.status === 'Success'),
  }]))
  return { passed: tests.length > 0 && tests.every(test => test.status === 'Success') && Object.values(scenarios).every(value => value.passed), scenarios, tests }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: bun e2e/src/local-coverage.ts <output.json>; LOCAL_FORGE may select pinned Forge 1.8.3')
  const oracleRoot = fileURLToPath(new URL('../../', import.meta.url))
  const root = resolve(oracleRoot, '..')
  const output = resolve(process.argv[2])
  if (!output.startsWith(resolve(root, 'tmp') + '/') && !output.startsWith(resolve(root, 'tmp') + '\\')) throw new Error('Local evidence must remain under repository tmp/')
  const forge = process.env.LOCAL_FORGE ?? 'forge'
  const version = Bun.spawnSync([forge, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  if (version.exitCode !== 0 || !/Version:\s*1\.8\.3\b/.test(version.stdout.toString())) throw new Error('Pinned Forge 1.8.3 is required')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/PRIVATE_KEY|API_KEY|API_TOKEN|RPC_URL|MONAD_.*RPC|FOUNDRY_PROFILE|FORGE_SNAPSHOT/.test(name)))
  Object.assign(environment, { FOUNDRY_PROFILE: 'integration', FORGE_SNAPSHOT_EMIT: 'false' })
  const command = [forge, 'test', '--match-contract', '^(RealBookOracleTest|RealOracleServiceScenariosTest)$', '--network', 'monad', '--hardfork', 'monad:MonadTen', '--threads', '1', '--isolate', '--json']
  const child = Bun.spawn(command, { cwd: oracleRoot, env: environment, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(`${output}.stdout`, stdout)
  writeFileSync(`${output}.stderr`, stderr)
  let summary: ReturnType<typeof summarizeCoverage> | undefined
  let parseError: string | undefined
  try { summary = summarizeCoverage(JSON.parse(stdout)) } catch { parseError = 'Forge did not return a complete JSON test result; inspect retained stdout/stderr' }
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error('Cannot establish source provenance')
    return result.stdout.toString().trim()
  }
  const sourcePaths = [...git(['ls-files', 'contracts/src', 'oracle/src', 'oracle/test/integration']).split(/\r?\n/),
    'oracle/test/integration/RealOracleServiceScenarios.t.sol', 'oracle/e2e/src/local-coverage.ts']
  const sourceHashes = Object.fromEntries([...new Set(sourcePaths)].sort().map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path)).toString().replaceAll('\r\n', '\n')).digest('hex')]))
  const report = { schema: 'eros-local-oracle-e2e/1', scope: 'local-only', broadcast: false, independentReview: false,
    observedAt: new Date().toISOString(), sourceCommit: git(['rev-parse', 'HEAD']), workingTreeDirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
    toolchain: version.stdout.toString().trim(), command, exitCode, sourceHashes,
    // A failed process can never be hidden by partial passing JSON output.
    ...summary, passed: exitCode === 0 && summary?.passed === true, parseError,
    limitations: ['E1-E9 are local contract equivalents, not public service E2E receipts.',
      'Token, external report truth and assertion adjudication are controlled fixtures; local HTTP publisher and keeper execution are validated by local-stack separately.',
      'E10/E11 CRE deployment access and public OG3b completion remain separate.'] }
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, exitCode, output }))
  if (!report.passed) process.exitCode = 1
}

if (import.meta.main) await main()
