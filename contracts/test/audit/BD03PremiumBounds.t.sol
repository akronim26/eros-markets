// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PremiumMath as P} from "../../src/math/PremiumMath.sol";

/// @notice B-D03: the checked square of the positive endpoint in `PremiumMath._accumulate` cannot
///         overflow anywhere in `cumulative`'s input domain. In the sign-crossing branch the two
///         endpoints have opposite signs and differ by slope * duration, so the positive one is below
///         |lots| * |rate| * 3600 <= 2^40 * 1e18 * 3600 < 2^112, and its square is below 2^224.
contract BD03PremiumBoundsTest is Test {
    int256 private constant MAX_CASH = (int256(1) << 180) - 1;
    int128 private constant MAX_LOTS = int128(1) << 40;
    int256 private constant MAX_RATE = 1e18;

    function _tariff() private pure returns (P.Tariff memory) {
        return P.Tariff(1e18, 1e18, 1e18);
    }

    /// The crossing branch at the largest slope: the positive endpoint is 2^40 * 1e18 * 1800 Q.
    function testCrossingAtMaximumSlopeDoesNotRevert() public pure {
        int256 slope = int256(MAX_LOTS) * MAX_RATE;
        // The outcome-0 deficit -cash starts at -slope * 1800 and ends at +slope * 1800.
        P.Segment memory s = P.Segment(slope * 1800, MAX_LOTS, MAX_RATE, 0, 3600, 3600);
        uint256 total = P.cumulative(s, _tariff(), 3600);
        // Lower bound: the outcome-0 triangle alone, without the ceiling.
        // Area = (slope * 1800)^2 / (2 * slope) = slope * 1800^2 / 2 Q*s, times hazard * load * 4
        // over 86400 s/day and the 1e36 WAD^2 scale.
        uint256 triangle = uint256(slope) * 1800 * 1800 / 2;
        assertGe(total, triangle * 8 / 86400);
    }

    /// Random points of the documented domain never revert.
    function testFuzzCumulativeDomainDoesNotRevert(
        int256 principal,
        int128 lots,
        int256 rate,
        uint64 duration,
        uint64 stop,
        uint64 surcharge
    ) public pure {
        principal = bound(principal, -MAX_CASH, MAX_CASH);
        lots = int128(bound(lots, -MAX_LOTS, MAX_LOTS));
        rate = bound(rate, -MAX_RATE, MAX_RATE);
        duration = uint64(bound(duration, 0, 3600));
        stop = uint64(bound(stop, 0, 3600));
        surcharge = uint64(bound(surcharge, 0, 3600));
        P.Segment memory s = P.Segment(principal, lots, rate, 0, stop, surcharge);
        P.cumulative(s, _tariff(), duration);
    }
}
