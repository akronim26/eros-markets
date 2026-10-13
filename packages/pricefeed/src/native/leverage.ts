/**
 * Leverage rule a native-priced perp engine must satisfy before its workers start (followup_deployment
 * step 4). Mirrors `ListNativeSpotPerp.s.sol`: funding is off, and a ceiling above 1x is accepted only
 * with forced-book liquidation on (`maxLiqLotsPerBlock > 0`) and a risk profile staged by the activation
 * Timelock operation (a non-zero active profile hash). A 1x engine needs neither.
 */
export interface NativeLeverageListing { deploymentCapX: bigint; maxLiqLotsPerBlock: bigint; fundingEnabled: boolean }

const ZERO_HASH = /^0x0{64}$/i;

export function nativeLeverageOk(l: NativeLeverageListing, activeProfileHash: string): boolean {
  if (l.fundingEnabled !== false || l.deploymentCapX < 1n) return false;
  if (l.deploymentCapX === 1n) return true;
  return l.maxLiqLotsPerBlock > 0n && /^0x[0-9a-f]{64}$/i.test(activeProfileHash) && !ZERO_HASH.test(activeProfileHash);
}
