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

/** Select exactly the verified incoming markets. Retired deployments are not served or archived. */
export function selectCurrentManifest(incoming: PublicManifest[]) {
  if (!incoming.length) throw Error('VERIFIED_DEPLOYMENTS_REQUIRED')
  const base = incoming[0]
  if (base.chainId !== 10143 || incoming.some(m => m.chainId !== base.chainId || !m.verifiedAt))
    throw Error('VERIFIED_SAME_CHAIN_DEPLOYMENTS_REQUIRED')
  if (incoming.some(m => !sameSharedContracts(base, m))) throw Error('INCOMING_SHARED_DEPLOYMENT_MISMATCH')
  return toPublicManifest({ ...base, markets: incoming.flatMap(m => m.markets) })
}
