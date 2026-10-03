// Task O31.1: the state version in the job key (plan §9.1). The oracle has no version counter, so the keeper uses
// the keccak256 of the ABI-encoded Resolution: any change to a market's resolution (state, attempts, request count,
// assertion, deadlines, ...) gives a new version, and a job planned on an older one is dropped.
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
