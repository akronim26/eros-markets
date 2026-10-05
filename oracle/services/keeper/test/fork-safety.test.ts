import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployStack } from './fork/stack'
import { assertForkUrl, assertFreeForkPort, assertOwnedForkNode, createForkDirectory, forkEnvironment } from './fork/safety'

describe('owned local fork harness', () => {
  test('refuses an occupied loopback port before any Anvil or Forge process is spawned', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve))
    const port = (server.address() as { port: number }).port
    const spawn = spyOn(Bun, 'spawn')
    try {
      await expect(deployStack(port)).rejects.toThrow('FORK_PORT_UNAVAILABLE')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await expect(assertFreeForkPort(port)).resolves.toBeUndefined()
  })

  test('rejects public/redirect-shaped endpoints and invalid ports', async () => {
    for (const url of ['https://127.0.0.1:8545', 'http://public.example:8545', 'http://127.0.0.1:8545/path',
      'http://user:secret@127.0.0.1:8545', 'http://127.0.0.1:8545?rpc=public', 'http://127.0.0.1:65536']) {
      expect(() => assertForkUrl(url)).toThrow('FORK_LOOPBACK_ONLY')
    }
    for (const port of [0, -1, 65536, 8545.5]) await expect(assertFreeForkPort(port)).rejects.toThrow('FORK_INVALID_PORT')
  })

  test('strips inherited credentials, arbitrary controls and proxy/public RPC settings while pinning every RPC alias', () => {
    const url = 'http://127.0.0.1:28545'
    const env = forkEnvironment(url, { PATH: 'pinned-foundry;system', SystemRoot: 'C:\\Windows', FOUNDRY_PROFILE: 'integration',
      PRIVATE_KEY: 'secret', DEPLOYER_PRIVATE_KEY: 'secret', API_KEY: 'secret', VENDOR_API_TOKEN: 'secret',
      ETH_RPC_URL: 'https://public.example', RPC_URL: 'https://public.example', FOUNDRY_ETH_RPC_URL: 'https://public.example',
      MONAD_TESTNET_RPC_URL: 'https://public.example', HTTPS_PROXY: 'https://proxy.example', PRODUCTION: 'true',
      TEAM_SAFE: 'public-safe', ETH_KEYSTORE: 'personal-wallet', ETH_PASSWORD: 'secret' }, { TEAM_SAFE: 'fixture-safe', PARAMS: 'owned/params.json' })
    expect(env).toEqual({ PATH: 'pinned-foundry;system', SystemRoot: 'C:\\Windows', FOUNDRY_PROFILE: 'integration',
      TEAM_SAFE: 'fixture-safe', PARAMS: 'owned/params.json', ETH_RPC_URL: url, RPC_URL: url, FOUNDRY_ETH_RPC_URL: url, FORGE_SNAPSHOT_EMIT: 'false' })
    for (const key of ['RPC_URL', 'ETH_RPC_URL', 'PRIVATE_KEY', 'HTTPS_PROXY', 'API_KEY']) {
      expect(() => forkEnvironment(url, {}, { [key]: 'unsafe' })).toThrow('FORK_UNSAFE_ENV_OVERRIDE')
    }
  })

  test('keeps prior evidence intact and allocates a different empty directory for the same port', () => {
    const root = mkdtempSync(join(tmpdir(), 'eros-fork-safety-'))
    const first = createForkDirectory(root, 28545)
    writeFileSync(join(first.absolute, 'receipt.json'), '{"retain":true}')
    const second = createForkDirectory(root, 28545)
    expect(first.absolute).not.toBe(second.absolute)
    expect(readFileSync(join(first.absolute, 'receipt.json'), 'utf8')).toBe('{"retain":true}')
    expect(readdirSync(second.absolute)).toEqual([])
    expect(second.relative.startsWith('deployments/dryrun/keeper-fork-28545-')).toBe(true)
    expect(existsSync(first.absolute)).toBe(true)
  })

  test('requires both an alive spawned child and Anvil chain 31337, including after async identity reads', async () => {
    const url = 'http://127.0.0.1:28545'
    const child = { pid: 123, exitCode: null as number | null }
    const read = async (_url: string, method: string) => method === 'eth_chainId' ? '0x7a69' : 'anvil/v1.8.3'
    await expect(assertOwnedForkNode(url, child, read)).resolves.toBeUndefined()
    await expect(assertOwnedForkNode(url, child, async (_url, method) => method === 'eth_chainId' ? '0x279f' : 'anvil/v1.8.3')).rejects.toThrow('FORK_WRONG_CHAIN')
    await expect(assertOwnedForkNode(url, child, async (_url, method) => method === 'eth_chainId' ? '0x7a69' : 'geth/v1')).rejects.toThrow('FORK_NOT_ANVIL')
    child.exitCode = 1
    let called = false
    await expect(assertOwnedForkNode(url, child, async () => { called = true; return '0x7a69' })).rejects.toThrow('FORK_ANVIL_CHILD_EXITED')
    expect(called).toBe(false)
    child.exitCode = null
    await expect(assertOwnedForkNode(url, child, async (_url, method) => {
      if (method === 'web3_clientVersion') child.exitCode = 1
      return read(_url, method)
    })).rejects.toThrow('FORK_ANVIL_CHILD_EXITED')
  })
})
