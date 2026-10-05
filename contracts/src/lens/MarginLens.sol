// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MarginMath} from "../math/MarginMath.sol";
import {HorizonMath} from "../math/HorizonMath.sol";

/// @notice Stateless display lens. Uses the engine's exact kernel and calibration expiry rule.
/// Never an admission authority: previewOrder and previewRelease govern actual transactions.
contract MarginLens {
    function sideMargin(
        uint256 lots,
        bool isLong,
        uint256 price,
        uint256 secsToT,
        uint256 nowTs,
        MarginMath.RiskParams memory p
    ) external pure returns (MarginMath.Margin memory) {
        return MarginMath.sideMargin(lots, isLong, price, secsToT, nowTs, _effective(p, nowTs));
    }

    function health(
        int256 cash,
        int256 lots,
        uint256 price,
        uint256 secsToT,
        uint256 nowTs,
        MarginMath.RiskParams memory p
    ) public pure returns (MarginMath.Health memory) {
        uint256 size = uint256(lots < 0 ? -lots : lots);
        return MarginMath.health(
            cash,
            lots,
            price,
            MarginMath.sideMargin(size, lots > 0, price, secsToT, nowTs, _effective(p, nowTs))
        );
    }

    function healthRange(
        int256 cash,
        int256 lots,
        uint16 first,
        uint16 last,
        uint256 secsToT,
        uint256 nowTs,
        MarginMath.RiskParams memory p
    ) external pure returns (MarginMath.Health[] memory values) {
        require(first > 0 && last < 1000 && first <= last && last - first < 50, "range");
        values = new MarginMath.Health[](last - first + 1);
        for (uint16 tick = first; tick <= last; tick++) {
            values[tick - first] = health(cash, lots, uint256(tick) * 1e15, secsToT, nowTs, p);
        }
    }

    function _effective(MarginMath.RiskParams memory p, uint256 nowTs)
        private
        pure
        returns (MarginMath.RiskParams memory)
    {
        if (
            !HorizonMath.isValidEnvelope(p.realized) || !HorizonMath.isValidEnvelope(p.templateEnv)
                || nowTs < p.realized.validFrom || nowTs >= p.realized.validUntil
                || nowTs < p.templateEnv.validFrom || nowTs >= p.templateEnv.validUntil
        ) p.calibrated = false;
        return p;
    }
}
