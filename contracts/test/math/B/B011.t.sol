// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {HorizonMath} from "../../../src/math/HorizonMath.sol";

/// @dev Shared fixture profile (spec §7.9 / §9.1): empirical envelopes explicitly zero.
library RiskFixture {
    function envelope(uint256 sigmaWad) internal pure returns (HorizonMath.Envelope memory e) {
        e.hSecs = new uint64[](1);
        e.sigmaWad = new uint256[](1);
        e.hSecs[0] = 1e12;
        e.sigmaWad[0] = sigmaWad;
        e.validFrom = 0;
        e.validUntil = type(uint64).max;
    }

    function profile(uint256 cap, bool calibrated) internal pure returns (MarginMath.RiskParams memory p) {
        p.h0Secs = 300;
        p.absorptionClaimsPerMin = 1000;
        p.queueSecs = 0;
        p.hazard0WadPerDay = 1e14;
        p.hazard1WadPerDay = 1e14;
        p.epsilonWad = 1e16;
        p.gammaWad = 15e17;
        p.sWad = 5e15;
        p.lambdaWadPerClaim = 1e12;
        p.template = MarginMath.Template.SCHEDULED;
        p.calibrated = calibrated;
        p.deploymentCapX = cap;
        p.realized = envelope(0);
        p.templateEnv = envelope(0);
    }
}

/// B011: MarginMath against B005 reference vectors (reference/b/margin.py, to_q_up of the upper
/// bracket). Tolerance T-1: >= reference, at most max(1e3, 1e-12 relative) above it.
contract B011Test is Test {
    uint256 constant Q = 1e18;
    uint256 constant USDC = 1e24;
    uint256 constant T29 = 29 days;
    uint256 constant QW = 6e17;

    function assertUpper(uint256 sol, uint256 refHi, string memory what) internal pure {
        assertGe(sol, refHi, what);
        uint256 tol = refHi / 1e12 > 1e3 ? refHi / 1e12 : 1e3;
        assertLe(sol - refHi, tol, what);
    }

    function m(uint256 lots, bool isLong, uint256 q, uint256 secs)
        internal
        pure
        returns (MarginMath.Margin memory)
    {
        return MarginMath.sideMargin(lots, isLong, q, secs, 0, RiskFixture.profile(5, true));
    }

    function test_directFiveXLong() public pure {
        MarginMath.Margin memory r = m(1_000_000, true, QW, T29);
        assertFalse(r.fullBacking);
        assertEq(r.imQ, 120 * USDC, "IM exactly 120 USDC (cap branch)");
        assertEq(r.worstQ, 600 * USDC);
        assertUpper(r.mmQ, 63929058071268787211717393, "MM ~63.929058");
    }

    function test_shortIm95894() public pure {
        MarginMath.Margin memory r = m(1_000_000, false, QW, T29);
        assertUpper(r.mmQ, 63929141404671565047365589, "short MM");
        assertUpper(r.imQ, 95893712107007347571048384, "short IM ~95.8937");
    }

    function test_short80Fails100Passes() public pure {
        MarginMath.Margin memory r = m(1_000_000, false, QW, T29);
        MarginMath.Health memory h80 = MarginMath.health(int256(680 * USDC), -1_000_000, QW, r);
        MarginMath.Health memory h100 = MarginMath.health(int256(700 * USDC), -1_000_000, QW, r);
        assertEq(uint256(h80.markEquityQ), 80 * USDC);
        assertEq(uint8(h80.status), uint8(MarginMath.Status.BELOW_IM));
        assertEq(uint8(h100.status), uint8(MarginMath.Status.HEALTHY));
    }

    function test_referenceGrid() public pure {
        MarginMath.Margin memory r = m(1, true, QW, T29);
        assertUpper(r.mmQ, 58337995901789254987, "1 lot MM");
        assertUpper(r.imQ, 120000000000000000000, "1 lot IM");
        r = m(12345, false, 3e17, 7 days);
        assertUpper(r.mmQ, 1317011676085846767748289, "12345 short MM");
        assertUpper(r.imQ, 1975517514128770151622434, "12345 short IM");
        r = m(1e8, true, 5e17, T29);
        assertUpper(r.mmQ, 30455526988666473884023389833, "1e8 MM");
        assertUpper(r.imQ, 45683290482999710826035084749, "1e8 IM");
        r = m(500, true, 95e16, 3600);
        assertUpper(r.mmQ, 315520818886472859678405, "near T MM");
        assertUpper(r.imQ, 473281228329709289517608, "near T IM");
        r = m(1e7, false, 2e17, 20 days);
        assertUpper(r.mmQ, 1008344500299886992361596550, "1e7 short MM");
        assertEq(r.imQ, 1600000000000000000000000000, "cap branch");
    }

    function test_longWith120IsHealthyAt5x() public pure {
        MarginMath.Margin memory r = m(1_000_000, true, QW, T29);
        MarginMath.Health memory h = MarginMath.health(-int256(480 * USDC), 1_000_000, QW, r);
        assertEq(uint8(h.status), uint8(MarginMath.Status.HEALTHY));
        assertEq(h.e0Q, -int256(480 * USDC));
        assertEq(h.e1Q, int256(520 * USDC));
        (bool ok, uint256 bps) = MarginMath.displayLeverageBps(r.worstQ, h.markEquityQ);
        assertTrue(ok);
        assertEq(bps, 50_000);
    }

    function test_flatIsZero() public pure {
        MarginMath.Margin memory r = m(0, true, QW, T29);
        assertEq(r.mmQ + r.imQ + r.worstQ, 0);
        assertFalse(r.fullBacking);
        MarginMath.Health memory h = MarginMath.health(int256(5 * Q), 0, QW, r);
        assertEq(uint8(h.status), uint8(MarginMath.Status.FLAT));
    }

    function test_missingCalibrationIs1x() public pure {
        MarginMath.Margin memory r =
            MarginMath.sideMargin(1_000_000, true, QW, T29, 0, RiskFixture.profile(5, false));
        assertTrue(r.fullBacking);
        assertEq(r.capX, 1);
        assertEq(r.imQ, 600 * USDC);
        assertEq(r.reason, MarginMath.R_CAP_1X);
    }

    function test_expiredEnvelopeIsFullBacking() public pure {
        MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
        p.realized.validUntil = 10;
        MarginMath.Margin memory r = MarginMath.sideMargin(1_000_000, true, QW, T29, 10, p);
        assertTrue(r.fullBacking);
        assertEq(r.reason, MarginMath.R_MISSING_CALIBRATION);
    }

    function test_oneXUsesExactEndpoints() public pure {
        MarginMath.Margin memory r =
            MarginMath.sideMargin(1000, true, QW, T29, 0, RiskFixture.profile(1, true));
        assertTrue(r.fullBacking);
        MarginMath.Health memory h = MarginMath.health(0, 1000, QW, r);
        assertEq(uint8(h.status), uint8(MarginMath.Status.HEALTHY), "E0 = 0 exactly");
        h = MarginMath.health(-1, 1000, QW, r);
        assertEq(uint8(h.status), uint8(MarginMath.Status.BELOW_MM), "one Q short");
    }

    function test_negativeEquityNeverDivides() public pure {
        MarginMath.Margin memory r = m(1_000_000, true, QW, T29);
        MarginMath.Health memory h = MarginMath.health(-int256(600 * USDC), 1_000_000, QW, r);
        assertEq(uint8(h.status), uint8(MarginMath.Status.NONPOSITIVE));
        (bool ok,) = MarginMath.displayLeverageBps(r.worstQ, h.markEquityQ);
        assertFalse(ok);
        (ok,) = MarginMath.displayLeverageBps(r.worstQ, -1);
        assertFalse(ok);
    }

    function test_templateCaps() public pure {
        assertEq(MarginMath.directionalCap(MarginMath.Template.SCHEDULED, true, true, 99), 5);
        assertEq(MarginMath.directionalCap(MarginMath.Template.CONTINUOUS, false, true, 99), 3);
        assertEq(MarginMath.directionalCap(MarginMath.Template.DEADLINE, true, true, 99), 3);
        assertEq(MarginMath.directionalCap(MarginMath.Template.DEADLINE, false, true, 99), 1);
        assertEq(MarginMath.directionalCap(MarginMath.Template.UNSCHEDULED, true, true, 99), 1);
        assertEq(MarginMath.directionalCap(MarginMath.Template.SCHEDULED, true, true, 1), 1);
    }

    function testFuzz_imMonotoneAndBounded(uint40 a, uint40 b, bool isLong, uint64 q, uint32 secs)
        public
        pure
    {
        uint256 qq = bound(q, 1e15, 999e15);
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        MarginMath.Margin memory rl = m(lo, isLong, qq, secs);
        MarginMath.Margin memory rh = m(hi, isLong, qq, secs);
        assertLe(rl.imQ, rh.imQ, "IM nondecreasing in size");
        assertLe(rh.mmQ, rh.imQ);
        assertLe(rh.imQ, rh.worstQ);
        if (rl.fullBacking && lo > 0) assertTrue(rh.fullBacking, "full-backing switch is upward");
    }
}
