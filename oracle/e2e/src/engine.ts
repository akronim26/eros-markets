import { readFileSync } from 'node:fs'
import { ResolutionEngineStubAbi } from '@eros-oracle/oracle-sdk'
import { EngineAdapter, parseEngineConfig, type EngineReader } from './engine-adapter'
import { pc } from './stack'

// The legacy public harness remains explicitly stub by default. Local tests import the
// pure adapter, never this module or stack.ts (which loads historical testnet credentials).
export const engineConfig = parseEngineConfig(process.env.E2E_ENGINE_CONFIG
  ? JSON.parse(readFileSync(process.env.E2E_ENGINE_CONFIG, 'utf8')) : { kind: 'stub' })
const abi = engineConfig.kind === 'book-risk'
  ? JSON.parse(readFileSync(new URL('../../../artifacts/risk/book-risk-engine-abi.json', import.meta.url), 'utf8')).abi
  : ResolutionEngineStubAbi
export const engineAdapter = new EngineAdapter(engineConfig, pc as unknown as EngineReader, abi)
