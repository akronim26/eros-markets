// The Foundry side of `oracle-cli list`: the createMarket dry-run (forge/CheckPack.s.sol), run with `forge script`
// in the oracle root without an RPC; nothing is sent. The claim preview uses oracle-sdk's ClaimRenderer mirror (O30.3).

export const ORACLE_ROOT = new URL('../../../', import.meta.url).pathname
const FORGE_DIR = 'packages/oracle-cli/forge'

export class ForgeError extends Error {
  constructor(message: string, readonly output: string) {
    super(message)
  }
}

function forge(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const p = Bun.spawnSync(['forge', 'script', ...args], {
    cwd: ORACLE_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() }
}

/** The revert a failed script reports ("script failed: BadAllowList(3)"), or the last error line. */
function failure(out: string): string {
  const lines = out.split('\n')
  const failed = lines.find((l) => l.includes('script failed:'))
  if (failed) return failed.slice(failed.indexOf('script failed:') + 'script failed:'.length).trim()
  return lines.filter((l) => l.startsWith('Error')).pop() ?? 'forge script failed'
}

export type CheckOptions = { params: string; now?: bigint; providers?: string[]; minBond?: bigint }

/** createMarket with the pack against a throwaway stack (CheckPack.s.sol); throws with the revert. */
export function checkPack(packJson: string, o: CheckOptions): string {
  const env: Record<string, string> = { PACK_JSON: packJson, PARAMS: o.params }
  if (o.now !== undefined) env.NOW = o.now.toString()
  if (o.providers && o.providers.length > 0) env.PROVIDERS = o.providers.join(',')
  if (o.minBond !== undefined) env.MIN_BOND = o.minBond.toString()
  const r = forge([`${FORGE_DIR}/CheckPack.s.sol`, '--tc', 'CheckPack'], env)
  if (r.code !== 0) throw new ForgeError(`createMarket dry-run failed: ${failure(r.out)}`, r.out)
  const logs = r.out.slice(r.out.indexOf('== Logs =='))
  return logs.trim()
}
