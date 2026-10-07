import { toPublicManifest, type PublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest'

export function sameSharedContracts(left: PublicManifest, right: PublicManifest) {
  const keys = Object.keys(left.contracts)
  return left.chainId === right.chainId && keys.length === Object.keys(right.contracts).length
    && keys.every(key => {
      const a = left.contracts[key], b = right.contracts[key]
      return !!b && a.address.toLowerCase() === b.address.toLowerCase()
        && a.codehash.toLowerCase() === b.codehash.toLowerCase() && a.deployBlock === b.deployBlock
    })
}

/** Select exactly the verified incoming markets; preserve all other owner custody routes. */
export function selectDeploymentManifests(previous: PublicManifest, archives: PublicManifest[], incoming: PublicManifest[]) {
  if (!incoming.length) throw Error('VERIFIED_DEPLOYMENTS_REQUIRED')
  const base = incoming[0]
  if (base.chainId !== 10143 || [...incoming, previous, ...archives].some(m => m.chainId !== base.chainId || !m.verifiedAt))
    throw Error('VERIFIED_SAME_CHAIN_DEPLOYMENTS_REQUIRED')
  if (incoming.some(m => !sameSharedContracts(base, m))) throw Error('INCOMING_SHARED_DEPLOYMENT_MISMATCH')
  const selected = toPublicManifest({ ...base, markets: incoming.flatMap(m => m.markets) })
  const active = new Map(selected.markets.map(m => [m.engine.toLowerCase(), m]))
  const seen = new Set<string>()
  const retained = [previous, ...archives].flatMap(manifest => {
    const markets = manifest.markets.filter(m => {
      const key = m.engine.toLowerCase(), current = active.get(key)
      if (current) {
        if (!sameSharedContracts(manifest, selected) || current.marketId !== m.marketId || current.codehash !== m.codehash || current.listingHash !== m.listingHash)
          throw Error('ENGINE_IDENTITY_CONFLICT')
        return false
      }
      if (seen.has(key)) throw Error('DUPLICATE_ARCHIVED_ENGINE')
      seen.add(key)
      return true
    })
    return markets.length ? [toPublicManifest({ ...manifest, markets })] : []
  })
  return { selected, archives: retained }
}
