// The deployed testnet stack, the role keys and serialized sends. Keys come from the git-ignored env files
// (oracle/workflows/.env, oracle/deployments/testnet-keys.env); scenarios run as separate processes that share
// keys, so every send holds a per-account lock and takes its nonce from the chain.
import { type Deployments, loadDeployments, ORACLE_ROOT } from '@eros-oracle/oracle-sdk'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const fileEnv = {
  ...readEnvFile(join(ORACLE_ROOT, 'workflows/.env')),
  ...readEnvFile(join(ORACLE_ROOT, 'deployments/testnet-keys.env')),
}
export const env = (k: string): string => {
  const v = process.env[k] ?? fileEnv[k]
  if (!v) throw new Error(`missing ${k}`)
  return v
}

export type Role = 'LISTER' | 'KEEPER_1' | 'DEPLOYER' | 'SIM_RELAYER' | 'COMMITTEE_1' | 'COMMITTEE_2' | 'COMMITTEE_3'
export const key = (r: Role) => env(`${r}_PRIVATE_KEY`) as Hex
export const addr = (r: Role) => privateKeyToAccount(key(r)).address

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [env('MONAD_TESTNET_RPC')] } },
})

export const d: Deployments = loadDeployments('monad-testnet')
export const pc = createPublicClient({ chain: monadTestnet, transport: http(undefined, { retryCount: 6, retryDelay: 400 }) }) as PublicClient
export const at = (name: string) => d.contracts[name].address as Address

const LOCKS = join(ORACLE_ROOT, 'deployments/dryrun/e2e-locks')
export async function withLock<T>(account: Address, f: () => Promise<T>): Promise<T> {
  const dir = join(LOCKS, account.toLowerCase())
  mkdirSync(LOCKS, { recursive: true })
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir)
      break
    } catch {
      if (i > 600) throw new Error(`lock on ${account} held for 10 minutes`)
      await Bun.sleep(1000)
    }
  }
  try {
    return await f()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const transient = (e: unknown) => /RPC Request failed|limited|429|timeout|fetch failed|ECONNRESET|socket/i.test(String(e))

/** Retries `f` on transient RPC errors (rate limit, timeouts). */
export async function retry<T>(f: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (i >= tries || !transient(e)) throw e
      await Bun.sleep(2000 * (i + 1))
    }
  }
}

/**
 * Sends `data` from `role`; gas is the estimate x 1.15 (Monad bills the limit). Transient errors before the
 * broadcast are retried; once a hash exists only the receipt is waited for, so nothing is sent twice.
 */
async function sendRaw(role: Role, to: Address, data: Hex, value: bigint, what: string): Promise<TransactionReceipt> {
  const account = privateKeyToAccount(key(role))
  return withLock(account.address, async () => {
    const w = createWalletClient({ chain: monadTestnet, transport: http(), account })
    const hash = await retry(async () => {
      const est = await pc.estimateGas({ account, to, data, value })
      const nonce = await pc.getTransactionCount({ address: account.address, blockTag: 'pending' })
      return w.sendTransaction({ to, data, value, gas: (est * 115n) / 100n, nonce })
    })
    const r = await retry(() => pc.waitForTransactionReceipt({ hash, timeout: 120_000 }))
    if (r.status !== 'success') throw new Error(`${role} ${what} reverted: ${hash}`)
    return r
  })
}

/** Sends `abi.functionName(args)` from `role`. Throws on revert. */
export const send = (role: Role, to: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], value = 0n) =>
  sendRaw(role, to, encodeFunctionData({ abi, functionName, args } as never), value, functionName)

/** Raw calldata from `role` (a script-built transaction). */
export const sendData = (role: Role, to: Address, data: Hex) => sendRaw(role, to, data, 0n, 'raw send')

export const now = async () => (await pc.getBlock({ blockTag: 'latest' })).timestamp
