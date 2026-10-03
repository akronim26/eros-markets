// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {OracleConst, Path, UMAConfig} from "../types/OracleTypes.sol";

/// @title BondMath
/// @notice Assertion bond and liveness selection (plan §6.4 `livenessFor`, §6.5, D9, D11; task O10.4).
/// @dev Units: lots in, USDC atoms out. One lot is 0.001 claim and a claim pays 1e6 atoms at YES, so
///      `exposureAtoms = oiLots × 1000` (`OracleConst.ATOMS_PER_LOT`). The proportional term is rounded
///      up so the bond is never smaller than `bondBps` of the exposure. `oiLots × 1000` reverts on
///      overflow (checked arithmetic) instead of wrapping; engine OI is far below that.
library BondMath {
    error NoPath();

    /// @notice `max(minBond, venueMinimumBond, ceil(oiLots × 1000 × bondBps / 10 000))`.
    function bond(uint256 oiLots, uint256 minBond, uint16 bondBps, uint256 venueMinimumBond)
        internal
        pure
        returns (uint256 b)
    {
        b = FixedPointMathLib.mulDivUp(oiLots * OracleConst.ATOMS_PER_LOT, bondBps, OracleConst.BPS);
        if (minBond > b) b = minBond;
        if (venueMinimumBond > b) b = venueMinimumBond;
    }

    /// @notice The same bond from a market's UMA config.
    function bond(uint256 oiLots, UMAConfig memory uma, uint256 venueMinimumBond) internal pure returns (uint256) {
        return bond(oiLots, uma.minBond, uma.bondBps, venueMinimumBond);
    }

    /// @notice A watchdog is fresh when it is not revoked and its last heartbeat is at most
    ///         `heartbeatMaxAgeSecs` old. A watchdog that never sent a heartbeat (`lastHeartbeat == 0`)
    ///         is stale.
    function isWatchdogFresh(uint64 nowTs, uint64 lastHeartbeat, uint32 heartbeatMaxAgeSecs, bool revoked)
        internal
        pure
        returns (bool)
    {
        if (revoked || lastHeartbeat == 0 || lastHeartbeat > nowTs) return false;
        return nowTs - lastHeartbeat <= heartbeatMaxAgeSecs;
    }

    /// @notice L1 → `livenessL1`, L2_AUTO → `livenessAuto`, both falling back to `livenessReviewed` when
    ///         the watchdog is not fresh; REVIEWED and PERMISSIONLESS → `livenessReviewed`.
    function liveness(Path path, UMAConfig memory uma, bool watchdogFresh) internal pure returns (uint64) {
        if (path == Path.NONE) revert NoPath();
        if (path == Path.L1 && watchdogFresh) return uma.livenessL1;
        if (path == Path.L2_AUTO && watchdogFresh) return uma.livenessAuto;
        return uma.livenessReviewed;
    }
}
