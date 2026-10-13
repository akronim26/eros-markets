import { gasLimit, type GasTable } from '@eros-oracle/oracle-sdk'
import { z } from 'zod'
import type { Job } from './types'

const realEngineGasSchema = z.object({
  limit: z.number().int().positive().safe(),
  engine: z.enum(['BookRiskEngine', 'RegistryBookRiskEngine']),
  engineRuntimeCodehashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1),
  measurement: z.object({
    chainId: z.number().int().positive().safe(),
    source: z.string().trim().min(1),
    transactionGas: z.number().int().positive().safe(),
  }),
})

export function measuredJobGas(table: GasTable, job: Job): bigint {
  const limit = gasLimit(table, job.gasKey)
  const identity = job.engineIdentity
  const touchesEngine = job.target === 'Engine' || ['haltScheduled', 'finalizeMarket', 'voidMarket'].includes(job.functionName)
  if (identity?.kind !== 'book-risk' || !touchesEngine) return limit
  const parsed = realEngineGasSchema.safeParse(table.calls[job.gasKey])
  if (!parsed.success) throw new Error(`${job.gasKey}: missing BookRiskEngine gas provenance`)
  const provenance = parsed.data
  if (provenance.measurement.chainId !== identity.chainId) throw new Error(`${job.gasKey}: gas measurement chainId does not match the engine`)
  if (!provenance.engineRuntimeCodehashes.some((codehash) => codehash.toLowerCase() === identity.runtimeCodehash)) {
    throw new Error(`${job.gasKey}: gas measurement does not cover engine runtime ${identity.runtimeCodehash}`)
  }
  if (limit < BigInt(provenance.measurement.transactionGas)) throw new Error(`${job.gasKey}: gas limit is below the measured transaction gas`)
  return limit
}
