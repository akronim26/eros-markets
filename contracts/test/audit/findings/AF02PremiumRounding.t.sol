// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";
import {ReferenceVectors as V} from "../../math/A/ReferenceVectors.sol";

/// @notice Reproducer for audit finding A-F02 (docs/merge/A-audit.md). Expected to FAIL until fixed.
contract FindingAF02PremiumRoundingTest is Test {
    // Spec section 6.3: charge ceil_Q(exact cumulative integral) - alreadyPosted.
    // A's own Fraction vectors store ceil(exact); A's Solidity is accepted within +11 Q.
    // This asserts the spec rule exactly (A-F02).
    function testPremiumMatchesCeilOfExactCumulative() public {
        int256[7][] memory v = V.premium();
        uint256 mismatches;
        uint256 maxOver;
        for (uint256 i; i < v.length; i++) {
            P.Segment memory s =
                P.Segment(v[i][0], int128(v[i][1]), v[i][2], 0, uint64(uint256(v[i][4])), uint64(uint256(v[i][5])));
            uint256 actual = P.cumulative(s, P.Tariff(1e14, 1e14, 1e18), uint64(uint256(v[i][3])));
            if (actual != uint256(v[i][6])) ++mismatches;
            if (actual > uint256(v[i][6]) && actual - uint256(v[i][6]) > maxOver) maxOver = actual - uint256(v[i][6]);
        }
        emit log_named_uint("max_overcharge_Q", maxOver);
        assertEq(mismatches, 0, "premium differs from ceil(exact cumulative)");
    }
}
