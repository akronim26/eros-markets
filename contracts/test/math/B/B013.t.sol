// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PricingMath as PM} from "../../../src/math/PricingMath.sol";

/// B013: PricingMath against the B007 reference cases (reference/b/pricing.py; same inputs,
/// expected values from the reference test and golden cases G13/G16/G20).
contract B013Test is Test {
    int256 constant W = 1e18;

    function s(uint64 t, int256 p) internal pure returns (PM.Sample memory) {
        return PM.Sample(t, p, true);
    }

    function arr2(PM.Sample memory a, PM.Sample memory b) internal pure returns (PM.Sample[] memory x) {
        x = new PM.Sample[](2);
        (x[0], x[1]) = (a, b);
    }

    function test_irregularSpacingTimeWeighted() public pure {
        PM.Twap memory r = PM.twap(arr2(s(100, 4e17), s(120, 7e17)), 130, 30, 30);
        assertTrue(r.available);
        assertEq(r.twapWad, 5e17);
        assertTrue(r.twapWad != (4e17 + 7e17) / 2, "not a sample-count average");
    }

    function test_sameTimestampNoWeight() public pure {
        PM.Twap memory a = PM.twap(arr2(s(100, 4e17), s(100, 6e17)), 130, 30, 30);
        PM.Sample[] memory one = new PM.Sample[](1);
        one[0] = s(100, 6e17);
        PM.Twap memory b = PM.twap(one, 130, 30, 30);
        assertEq(a.integral, b.integral);
        assertEq(a.twapWad, b.twapWad);
    }

    function test_manySamplesOneSecond() public pure {
        PM.Sample[] memory x = new PM.Sample[](7);
        x[0] = s(100, 4e17);
        for (uint256 i = 1; i < 6; ++i) {
            x[i] = s(119, 9e17);
        }
        x[6] = s(120, 7e17);
        PM.Twap memory r = PM.twap(x, 130, 30, 30);
        assertEq(r.integral, 4e17 * 19 + 9e17 + 7e17 * 10);
    }

    function test_gapNotCarried() public pure {
        PM.Twap memory r = PM.twap(arr2(s(0, 5e17), s(60, 5e17)), 90, 90, 30);
        assertFalse(r.available);
        assertEq(r.coveredSecs, 60);
        assertEq(r.twapWad, 0);
    }

    function test_exact30sBoundary() public pure {
        PM.Sample[] memory one = new PM.Sample[](1);
        one[0] = s(0, 5e17);
        assertTrue(PM.twap(one, 30, 30, 30).available);
        assertFalse(PM.twap(one, 31, 31, 30).available);
    }

    function test_invalidSampleBreaksCoverage() public pure {
        PM.Sample[] memory x = new PM.Sample[](3);
        x[0] = s(0, 5e17);
        x[1] = PM.Sample(10, 0, false);
        x[2] = s(20, 5e17);
        PM.Twap memory r = PM.twap(x, 30, 30, 30);
        assertEq(r.coveredSecs, 20);
        assertFalse(r.available);
    }

    function test_emptyWindow() public pure {
        PM.Twap memory r = PM.twap(new PM.Sample[](0), 300, 300, 30);
        assertFalse(r.available);
        assertEq(r.coveredSecs, 0);
    }

    function test_carryInAndFutureIgnored() public pure {
        assertEq(PM.twap(arr2(s(95, 3e17), s(110, 3e17)), 130, 30, 30).twapWad, 3e17);
        PM.Sample[] memory x = new PM.Sample[](31);
        for (uint256 i; i < 30; ++i) {
            x[i] = s(uint64(i * 10), 4e17);
        }
        x[30] = s(301, 9e17);
        assertEq(PM.twap(x, 300, 300, 30).twapWad, 4e17);
    }

    function test_floorRounding() public pure {
        PM.Sample[] memory x = new PM.Sample[](3);
        (x[0], x[1], x[2]) = (s(0, 1), s(1, 2), s(2, 2));
        assertEq(PM.twap(x, 3, 3, 30).twapWad, 1);
        (x[0], x[1], x[2]) = (s(0, -1), s(1, -2), s(2, -2)); // negative basis floors downward
        assertEq(PM.twap(x, 3, 3, 30).twapWad, -2);
    }

    function test_unsortedReverts() public {
        vm.expectRevert(PM.Unsorted.selector);
        this.twapExt(arr2(s(10, 1), s(5, 1)), 20, 10);
    }

    function twapExt(PM.Sample[] memory x, uint64 end, uint64 win) external pure returns (PM.Twap memory) {
        return PM.twap(x, end, win, 30);
    }

    function test_freshnessBoundary() public pure {
        PM.Sample[] memory one = new PM.Sample[](1);
        one[0] = s(1000, 5e17);
        (bool ok,) = PM.valueAt(one, 1030, 30);
        assertTrue(ok);
        (ok,) = PM.valueAt(one, 1031, 30);
        assertFalse(ok);
        (ok,) = PM.valueAt(one, 999, 30);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ cumulative form

    function testFuzz_cumulativeMatchesDirect(uint8 n, uint256 seed, uint16 winSel) public pure {
        uint256 len = bound(n, 1, 20);
        PM.Sample[] memory x = new PM.Sample[](len);
        uint64 t = 1000;
        for (uint256 i; i < len; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            t += uint64(seed % 45);
            x[i] = PM.Sample(t, int256(seed % 1e18), seed % 7 != 0);
        }
        uint64 end = t + uint64(bound(winSel, 0, 40));
        uint64 win = uint64(bound(winSel, 1, end - 900));
        PM.Twap memory direct = PM.twap(x, end, win, 30);
        (int256 i0, uint256 c0) = _cumAt(x, end - win);
        (int256 i1, uint256 c1) = _cumAt(x, end);
        PM.Twap memory viaCum = PM.twapFromCum(i0, c0, i1, c1, win);
        assertEq(viaCum.coveredSecs, direct.coveredSecs);
        assertEq(viaCum.integral, direct.integral);
        assertEq(viaCum.available, direct.available);
        assertEq(viaCum.twapWad, direct.twapWad);
    }

    function _cumAt(PM.Sample[] memory x, uint64 t) internal pure returns (int256, uint256) {
        PM.Cum memory cp;
        bool started;
        for (uint256 i; i < x.length && x[i].t <= t; ++i) {
            if (!started) {
                cp = PM.Cum(x[i].t, x[i].priceWad, x[i].valid, 0, 0);
                started = true;
            } else {
                cp = PM.extend(cp, x[i].t, x[i].priceWad, x[i].valid, 30);
            }
        }
        if (!started) return (0, 0);
        return PM.cumAt(cp, t, 30);
    }

    // ------------------------------------------------------------------ depth / mark / funding

    function test_impactMid() public pure {
        (bool ok, uint256 m) = PM.impactMid(59e16, 61e16, 500, 500, 500, 5e16);
        assertTrue(ok);
        assertEq(m, 6e17);
        (ok,) = PM.impactMid(59e16, 61e16, 499, 500, 500, 5e16);
        assertFalse(ok);
        (ok,) = PM.impactMid(59e16, 61e16, 500, 500, 500, 1e16);
        assertFalse(ok);
        (ok,) = PM.impactMid(61e16, 59e16, 500, 500, 500, 1e17);
        assertFalse(ok);
    }

    function test_goldenMarkBand() public pure {
        assertEq(PM.bandWad(432000, 864000, 0), 25e15);
        PM.MarkInputs memory m = PM.MarkInputs(true, 6e17, true, 4e16, true, 66e16, true, 7e17);
        (bool ok, uint256 q) = PM.mark(m, 432000, 864000, 0);
        assertTrue(ok);
        assertEq(q, 625e15);
    }

    function test_allMedianOrderings() public pure {
        int256[3] memory v = [int256(61e16), 62e16, 63e16];
        uint8[3][6] memory perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        for (uint256 i; i < 6; ++i) {
            PM.MarkInputs memory m = PM.MarkInputs(
                true,
                6e17,
                true,
                v[perms[i][0]] - 6e17,
                true,
                uint256(v[perms[i][1]]),
                true,
                uint256(v[perms[i][2]])
            );
            (, uint256 q) = PM.mark(m, 0, 1e6, 0);
            assertEq(q, 62e16);
        }
    }

    function test_missingCandidateUnavailable() public pure {
        PM.MarkInputs memory m = PM.MarkInputs(true, 6e17, false, 0, true, 6e17, true, 6e17);
        (bool ok,) = PM.mark(m, 0, 10, 0);
        assertFalse(ok);
    }

    function test_bandZeroAtT() public pure {
        PM.MarkInputs memory m = PM.MarkInputs(true, 6e17, true, 1e17, true, 7e17, true, 7e17);
        (, uint256 q) = PM.mark(m, 1000, 1000, 0);
        assertEq(q, 6e17);
    }

    function test_goldenFundingRate() public pure {
        assertEq(PM.fundingRate(62e16, 60e16), 231481481481481);
        assertEq(PM.fundingRate(55e16, 60e16), -231481481481481);
        assertEq(PM.fundingRate(61e16, 60e16), 115740740740740); // trunc(1e19 / 86400)
        assertEq(PM.fundingRate(6e17 + 7, 6e17), 0); // truncated toward zero
        assertEq(PM.fundingRate(6e17 - 7, 6e17), 0);
    }

    function test_epochRecommendation() public pure {
        (bool a,, uint8 r) = PM.recommendEpochRate(false, true, 6e17, 6e17, 10);
        assertEq(r, PM.FUNDING_DISABLED);
        (a,, r) = PM.recommendEpochRate(true, false, 6e17, 6e17, 10);
        assertEq(r, PM.FUNDING_STALE_PRICE);
        (a,, r) = PM.recommendEpochRate(true, true, 62e16, 6e17, 0);
        assertEq(r, PM.FUNDING_ZERO_OI);
        assertFalse(a);
        int256 rate;
        (a, rate,) = PM.recommendEpochRate(true, true, 62e16, 6e17, 10);
        assertTrue(a);
        assertEq(rate, 231481481481481);
    }

    function test_movementTrigger() public pure {
        PM.Sample[] memory x = new PM.Sample[](32);
        x[0] = s(0, 50e16);
        for (uint256 i = 1; i < 31; ++i) {
            x[i] = s(uint64(i * 10), 50e16);
        }
        x[31] = s(300, 61e16);
        assertTrue(PM.movementTrigger(x, 300));
        x[31] = s(300, 60e16);
        assertFalse(PM.movementTrigger(x, 300), "exactly 0.10 does not exceed");
        PM.Sample[] memory one = new PM.Sample[](1);
        one[0] = s(300, 9e17);
        assertFalse(PM.movementTrigger(one, 300));
    }
}
