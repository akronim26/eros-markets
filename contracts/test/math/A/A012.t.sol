// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";

contract A012Test {
    function testTriangles() public pure {
        assert(P.positiveIntegralUp(-10, 1, 20) == 50);
        assert(P.positiveIntegralUp(10, -1, 20) == 50);
    }

    function testNeutralTouches() public pure {
        P.Segment memory s = P.Segment(-100e24, 3600, 1e18, 0, 3000, 1800);
        P.Tariff memory t = P.Tariff(1e14, 1e14, 1e18);
        uint256 paid;
        for (uint64 i = 300; i <= 3600; i += 300) {
            uint256 total = P.cumulative(s, t, i);
            paid += total - paid;
        }
        assert(paid == P.cumulative(s, t, 3600));
    }
}
