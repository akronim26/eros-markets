import { readFileSync } from 'node:fs'
import { getAddress, type Hex, keccak256 } from 'viem'
import { z } from 'zod'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => getAddress(value))
const codehash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
  .refine((value) => BigInt(value) !== 0n, 'runtime codehash must not be zero')
  .transform((value) => value.toLowerCase() as Hex)

const engineIdentitiesSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int().positive(),
  registry: address,
  profiles: z.array(z.object({
    kind: z.enum(['stub', 'book-risk']),
    runtimeCodehash: codehash,
  }).strict()).min(1),
}).strict().refine((value) => new Set(value.profiles.map((profile) => profile.runtimeCodehash)).size === value.profiles.length, {
  message: 'runtime codehashes must be unique',
})

export type EngineIdentities = z.infer<typeof engineIdentitiesSchema>
export type EngineIdentity = EngineIdentities['profiles'][number] & { chainId: number }
export type EngineIdentityContext = { chainId: number; registry: Hex }
export type EngineIdentityClient = {
  getChainId(): Promise<number>
  getCode(args: { address: Hex; blockTag: 'latest' }): Promise<Hex | undefined>
}

export function parseEngineIdentities(value: unknown, expected: EngineIdentityContext): EngineIdentities {
  const identities = engineIdentitiesSchema.parse(value)
  if (identities.chainId !== expected.chainId) throw new Error(`engine identities chainId ${identities.chainId}, expected ${expected.chainId}`)
  if (identities.registry.toLowerCase() !== expected.registry.toLowerCase()) throw new Error('engine identities registry does not match the deployment')
  return identities
}

export function loadEngineIdentities(path: string, expected: EngineIdentityContext): EngineIdentities {
  return parseEngineIdentities(JSON.parse(readFileSync(path, 'utf8')), expected)
}

export function engineIdentityResolver(client: EngineIdentityClient, identities: EngineIdentities, expected: EngineIdentityContext) {
  const config = parseEngineIdentities(identities, expected)
  const profiles = new Map(config.profiles.map((profile) => [profile.runtimeCodehash, profile]))
  return async (engine: Hex): Promise<EngineIdentity> => {
    const chainId = await client.getChainId()
    if (chainId !== config.chainId) throw new Error(`engine identity RPC chainId ${chainId}, expected ${config.chainId}`)
    const code = await client.getCode({ address: engine, blockTag: 'latest' })
    if (!code || code === '0x') throw new Error(`engine ${engine} has no runtime code`)
    const runtimeCodehash = keccak256(code)
    const profile = profiles.get(runtimeCodehash)
    if (!profile) throw new Error(`engine ${engine} has unapproved runtime codehash ${runtimeCodehash}`)
    return { ...profile, chainId }
  }
}
