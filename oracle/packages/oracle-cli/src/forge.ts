// createMarket dry-run for `oracle-cli list` (forge/CheckPack.s.sol), run locally without an RPC.
import { fileURLToPath } from 'node:url'

export const ORACLE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
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

/** The revert reason ("script failed: BadAllowList(3)"), or the last error line. */
function failure(out: string): string {
  const lines = out.split('\n')
  const failed = lines.find((l) => l.includes('script failed:'))
  if (failed) return failed.slice(failed.indexOf('script failed:') + 'script failed:'.length).trim()
  return lines.filter((l) => l.startsWith('Error')).pop() ?? 'forge script failed'
}

export type CheckOptions = { params: string; now?: bigint; providers?: string[]; minBond?: bigint }

/** Throws with the revert reason. */
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
