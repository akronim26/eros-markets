import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { loadServiceDeployment } from '../../packages/oracle-sdk/src/deployments'
import { ORACLE_ROOT } from '../../packages/oracle-sdk/src/abi/sources'

export function loadListenerConfig(target = 'fresh-testnet', manifestFile?: string) {
  if (!['local-sim', 'fresh-testnet'].includes(target)) throw new Error('This listener only supports configured testnet simulation targets')
  const config = JSON.parse(readFileSync(join(ORACLE_ROOT, 'workflows', 'resolution', `config.${target}.json`), 'utf8'))
  const current = target === 'fresh-testnet' ? loadServiceDeployment('monad-testnet', { manifestFile }) : undefined
  if (current && config.oracle.toLowerCase() !== current.contracts.ResolutionOracle.address.toLowerCase()) {
    throw new Error('CRE fresh-testnet config differs from the current verified frontend manifest; update the config before starting')
  }
  return { oracle: config.oracle as Hex, startBlock: current?.contracts.ResolutionOracle.deployBlock }
}
