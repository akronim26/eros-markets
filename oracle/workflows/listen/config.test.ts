import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_TESTNET_MANIFEST, loadServiceDeployment } from '../../packages/oracle-sdk/src/deployments'
import { loadListenerConfig } from './config'

test('listener defaults to the same current oracle and its deploy block as services and frontend', () => {
  const current = loadServiceDeployment('monad-testnet')
  expect(loadListenerConfig()).toEqual({ oracle: current.contracts.ResolutionOracle.address, startBlock: current.contracts.ResolutionOracle.deployBlock })
  expect(loadListenerConfig('local-sim').oracle).not.toBe(loadListenerConfig().oracle)
  expect(() => loadListenerConfig('production')).toThrow()
})

test('a changed manifest cannot silently run the workflow against a stale oracle', () => {
  const manifest = JSON.parse(readFileSync(CURRENT_TESTNET_MANIFEST, 'utf8'))
  manifest.contracts.ResolutionOracle.address = `0x${'99'.repeat(20)}`
  const path = join(mkdtempSync(join(tmpdir(), 'cre-config-')), 'manifest.json')
  writeFileSync(path, JSON.stringify(manifest))
  expect(() => loadListenerConfig('fresh-testnet', path)).toThrow('differs from')
})
