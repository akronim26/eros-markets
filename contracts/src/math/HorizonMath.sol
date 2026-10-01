// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "./QMath.sol";
import {WAD} from "./RiskTypes.sol";

/// @title HorizonMath
/// @notice Closeout horizon and volatility upper bounds (spec §4.2; reference/b/horizon_volatility.py).
/// @dev Pure. Kernel units: seconds, wad prices, lots at the boundary. Every result rounds UP.
library HorizonMath {
    error BadUnits();
    error PriceNotInterior();

    /// @dev Empirical sigma upper envelope: strictly increasing horizons with nondecreasing sigma,
    ///      valid in [validFrom, validUntil). Raw noisy bins are not repaired here.
    struct Envelope {
        uint64[] hSecs;
        uint256[] sigmaWad;
        uint64 validFrom;
        uint64 validUntil;
    }

    /// @notice h = h0 + queue + ceil(|x| * 60 / v) seconds, |x| in lots, v in claims/minute.
    function horizonSecsUp(uint256 absLots, uint256 h0Secs, uint256 absorptionClaimsPerMin, uint256 queueSecs)
        internal
        pure
        returns (uint256)
    {
        if (absorptionClaimsPerMin == 0) revert BadUnits();
        return h0Secs + queueSecs + QMath.mulDivUp(absLots * 60, 1, 1000 * absorptionClaimsPerMin);
    }

    /// @notice Same horizon in wad-seconds (1e18 = 1 s), rounded up. The margin kernel uses this so
    ///         sub-second closeout time is not inflated to a whole second.
    function horizonWadUp(uint256 absLots, uint256 h0Secs, uint256 absorptionClaimsPerMin, uint256 queueSecs)
        internal
        pure
        returns (uint256)
    {
        if (absorptionClaimsPerMin == 0) revert BadUnits();
        return (h0Secs + queueSecs) * WAD + QMath.mulDivUp(absLots * 60 * WAD, 1, 1000 * absorptionClaimsPerMin);
    }

    /// @notice sigmaTheoryUp with the horizon in wad-seconds.
    function sigmaTheoryUpWad(uint256 qWad, uint256 hWad, uint256 secsToT) internal pure returns (uint256) {
        if (qWad == 0 || qWad >= WAD) revert PriceNotInterior();
        uint256 rad = QMath.mulDivUp(qWad * (WAD - qWad), hWad, (secsToT == 0 ? 1 : secsToT) * WAD);
        return QMath.min(QMath.sqrtUp(rad), WAD);
    }

    /// @notice min(1, sqrt(q(1-q) h / max(T-t, 1s))) rounded up, in wad.
    function sigmaTheoryUp(uint256 qWad, uint256 hSecs, uint256 secsToT) internal pure returns (uint256) {
        if (qWad == 0 || qWad >= WAD) revert PriceNotInterior();
        uint256 rad = QMath.mulDivUp(qWad * (WAD - qWad), hSecs, secsToT == 0 ? 1 : secsToT);
        return QMath.min(QMath.sqrtUp(rad), WAD);
    }

    function isValidEnvelope(Envelope memory e) internal pure returns (bool) {
        uint256 n = e.hSecs.length;
        if (n == 0 || n != e.sigmaWad.length) return false;
        for (uint256 i = 1; i < n; ++i) {
            if (e.hSecs[i] <= e.hSecs[i - 1] || e.sigmaWad[i] < e.sigmaWad[i - 1]) return false;
        }
        return true;
    }

    /// @notice Step-up envelope value: the first bin with horizon >= h. `ok == false` means
    ///         unavailable (invalid/nonmonotone bins, outside validity, h beyond the last bin);
    ///         the caller must then require full backing.
    function envelopeAt(Envelope memory e, uint256 hSecs, uint256 nowTs)
        internal
        pure
        returns (bool ok, uint256 s)
    {
        if (!isValidEnvelope(e) || nowTs < e.validFrom || nowTs >= e.validUntil) return (false, 0);
        for (uint256 i; i < e.hSecs.length; ++i) {
            if (e.hSecs[i] >= hSecs) return (true, e.sigmaWad[i]);
        }
        return (false, 0);
    }

    function sigmaUpper(uint256 theoryWad, uint256 realizedWad, uint256 templateWad)
        internal
        pure
        returns (uint256)
    {
        return QMath.min(WAD, QMath.max(theoryWad, QMath.max(realizedWad, templateWad)));
    }
}
