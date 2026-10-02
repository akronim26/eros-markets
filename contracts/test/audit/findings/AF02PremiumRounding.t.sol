// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";
import {ReferenceVectors as V} from "../../math/A/ReferenceVectors.sol";

/// @notice Regression for audit finding A-F02 (docs/merge/A-audit.md).
contract FindingAF02PremiumRoundingTest is Test {
    // Spec section 6.3: charge ceil_Q(exact cumulative integral) - alreadyPosted.
    function testPremiumMatchesCeilOfExactCumulative() public pure {
        int256[7][] memory vectors = V.premium();
        for (uint256 index; index < vectors.length; index++) {
            int256[7] memory vector = vectors[index];
            P.Segment memory segment = P.Segment(
                vector[0],
                int128(vector[1]),
                vector[2],
                0,
                uint64(uint256(vector[4])),
                uint64(uint256(vector[5]))
            );
            uint256 actual = P.cumulative(segment, P.Tariff(1e14, 1e14, 1e18), uint64(uint256(vector[3])));
            assertEq(actual, uint256(vector[6]), "premium differs from ceil(exact cumulative)");
        }
    }
}
