// The oracle has no version counter, so a market's state version is keccak256 of its ABI-encoded Resolution.
import { ResolutionOracleAbi } from '@eros-oracle/oracle-sdk'
import { encodeAbiParameters, type Hex, keccak256 } from 'viem'
import type { Job, Resolution } from './types'

const getResolution = ResolutionOracleAbi.find((x) => x.type === 'function' && x.name === 'getResolution')!
if (getResolution.type !== 'function') throw new Error('getResolution missing from the ABI')
const RESOLUTION = getResolution.outputs

export function stateVersion(r: Resolution): Hex {
  return keccak256(encodeAbiParameters(RESOLUTION, [r]))
}

export const jobKey = (j: Pick<Job, 'marketId' | 'stateVersion' | 'action'>): string =>
  `${j.marketId.toLowerCase()}:${j.stateVersion.toLowerCase()}:${j.action}`
