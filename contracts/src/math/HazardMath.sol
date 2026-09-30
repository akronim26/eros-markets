// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "../../provisional/QMath.sol";
import {WAD} from "../../provisional/MathTypes.sol";

/// @title HazardMath
/// @notice Linear hazard bounds, directional adverse probability, tail budget eps', Cantelli k and
///         conservative drift (spec §4.2, DEC-09; reference/b/hazards.py). Pure, wad units.
/// @dev Adverse probabilities, k and drift round UP; eps' rounds DOWN. Any domain failure returns
///      fullBacking = true with a reason; nothing here reverts on a risk-domain failure.
library HazardMath {
    error BadUnits();

    uint256 internal constant SECONDS_PER_DAY = 86400;

    uint8 internal constant OK = 0;
    uint8 internal constant SUM_AT_LEAST_ONE = 1; // a0 + a1 >= 1
    uint8 internal constant ADVERSE_AT_EPSILON = 2; // a_adv >= epsilon
    uint8 internal constant EPS_PRIME_ZERO = 3; // epsilon' rounds to 0

    struct Tail {
        bool fullBacking;
        uint8 reason;
        uint256 aAdvWad;
        uint256 epsPrimeWad;
        uint256 kWad;
    }

    /// @notice a = min(1, hazard * h / 86400), rounded up.
    function hazardUp(uint256 hazardWadPerDay, uint256 hSecs) internal pure returns (uint256) {
        return QMath.min(WAD, QMath.mulDivUp(hazardWadPerDay, hSecs, SECONDS_PER_DAY));
    }

    /// @notice Long adverse hazard is a0 (NO jump), short is a1 (YES jump).
    function tail(uint256 a0Wad, uint256 a1Wad, bool isLong, uint256 epsilonWad)
        internal
        pure
        returns (Tail memory t)
    {
        if (epsilonWad == 0 || epsilonWad >= WAD || a0Wad > WAD || a1Wad > WAD) revert BadUnits();
        if (a0Wad + a1Wad >= WAD) {
            t.fullBacking = true;
            t.reason = SUM_AT_LEAST_ONE;
            return t;
        }
        t.aAdvWad = isLong ? a0Wad : a1Wad;
        if (t.aAdvWad >= epsilonWad) {
            t.fullBacking = true;
            t.reason = ADVERSE_AT_EPSILON;
            return t;
        }
        t.epsPrimeWad = QMath.mulDivDown(epsilonWad - t.aAdvWad, WAD, WAD - t.aAdvWad);
        if (t.epsPrimeWad == 0) {
            t.fullBacking = true;
            t.reason = EPS_PRIME_ZERO;
            return t;
        }
        // k = sqrt((1 - eps') / eps'), in wad: sqrt((WAD - e) * WAD^2 / e), all rounded up.
        t.kWad = QMath.sqrtUp(QMath.mulDivUp(WAD - t.epsPrimeWad, WAD * WAD, t.epsPrimeWad));
    }

    /// @notice mLong = (1-q) a1 / (1-a0-a1); mShort = q a0 / (1-a0-a1). ok == false if a0+a1 >= 1.
    function driftUp(uint256 qWad, uint256 a0Wad, uint256 a1Wad, bool isLong)
        internal
        pure
        returns (bool ok, uint256 m)
    {
        if (qWad > WAD) revert BadUnits();
        if (a0Wad + a1Wad >= WAD) return (false, 0);
        uint256 denom = WAD - a0Wad - a1Wad;
        m = isLong ? QMath.mulDivUp(WAD - qWad, a1Wad, denom) : QMath.mulDivUp(qWad, a0Wad, denom);
        ok = true;
    }
}
