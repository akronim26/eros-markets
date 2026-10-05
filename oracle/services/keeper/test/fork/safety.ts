import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, relative } from 'node:path'

export type LocalChild = { pid: number; exitCode: number | null; signalCode?: string | number | null }
const OS_ENV = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|FOUNDRY_PROFILE|FOUNDRY_OUT|FOUNDRY_CACHE_PATH)$/i
const FORBIDDEN_ENV = /PRIVATE.?KEY|API.?KEY|API.?TOKEN|SECRET|PASSWORD|MNEMONIC|RPC|PROXY|KEYSTORE|ACCESS.?TOKEN|SESSION.?TOKEN/i

export function assertForkUrl(url: string) {
  const match = /^http:\/\/127\.0\.0\.1:([0-9]+)$/.exec(url)
  if (!match || !Number.isInteger(Number(match[1])) || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('FORK_LOOPBACK_ONLY')
}

/** No wallet/provider credentials or unrelated script controls cross into Anvil/Forge. */
export function forkEnvironment(url: string, inherited: Record<string, string | undefined>, explicit: Record<string, string> = {}): Record<string, string> {
  assertForkUrl(url)
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) if (value !== undefined && OS_ENV.test(name)) clean[name] = value
  for (const [name, value] of Object.entries(explicit)) {
    if (FORBIDDEN_ENV.test(name)) throw new Error(`FORK_UNSAFE_ENV_OVERRIDE:${name}`)
    clean[name] = value
  }
  return { ...clean, ETH_RPC_URL: url, RPC_URL: url, FOUNDRY_ETH_RPC_URL: url, FORGE_SNAPSHOT_EMIT: 'false' }
}

/** Bind first: an occupied listener is refused before starting any child or making RPC calls. */
export async function assertFreeForkPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FORK_INVALID_PORT')
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`FORK_PORT_UNAVAILABLE:${port}`, { cause: error })))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()))
  })
}

/** Evidence is retained; an existing run directory is never deleted or reused. */
export function createForkDirectory(root: string, port: number) {
  const parent = join(root, 'deployments', 'dryrun')
  mkdirSync(parent, { recursive: true })
  const absolute = mkdtempSync(join(parent, `keeper-fork-${port}-`))
  return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') }
}

export function assertForkChildAlive(child: LocalChild) {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode != null) throw new Error('FORK_ANVIL_CHILD_EXITED')
}

export async function assertOwnedForkNode(url: string, child: LocalChild, read: (url: string, method: string) => Promise<unknown>) {
  assertForkUrl(url)
  assertForkChildAlive(child)
  const chain = await read(url, 'eth_chainId')
  if (chain !== '0x7a69') throw new Error('FORK_WRONG_CHAIN')
  const version = await read(url, 'web3_clientVersion')
  if (typeof version !== 'string' || !/^anvil\//i.test(version)) throw new Error('FORK_NOT_ANVIL')
  assertForkChildAlive(child)
}
