// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {HorizonMath} from "../../../src/math/HorizonMath.sol";
import {HazardMath} from "../../../src/math/HazardMath.sol";

/// @dev Library calls go through this wrapper so reverts are catchable.
contract B010Wrapper {
    function tail(uint256 a0, uint256 a1, bool isLong, uint256 eps)
        external
        pure
        returns (HazardMath.Tail memory)
    {
        return HazardMath.tail(a0, a1, isLong, eps);
    }

    function sigma(uint256 q, uint256 h, uint256 s) external pure returns (uint256) {
        return HorizonMath.sigmaTheoryUp(q, h, s);
    }

    function horizon(uint256 x, uint256 h0, uint256 v, uint256 queue) external pure returns (uint256) {
        return HorizonMath.horizonSecsUp(x, h0, v, queue);
    }
}

/// B010: directed horizon/volatility and hazard/tail/drift bounds.
/// Expected values: reference/b (B003/B004, Fraction + 1e-40 sqrt brackets) floored/ceiled to wad.
/// Each Solidity bound must be >= the reference upper bracket (conservative) and within TOL of it.
contract B010Test is Test {
    uint256 constant WAD = 1e18;
    uint256 constant EPS = 1e16; // 0.01
    /// @dev Declared tolerance: a bound may exceed the reference upper bracket by at most
    ///      max(1e3 wad, 1e-12 relative). eps' is floored to wad before the square root, so the
    ///      excess of k grows like k / eps' * 1e-18 near epsilon.
    uint256 constant TOL_ABS = 1e3;
    uint256 constant TOL_REL = 1e12;

    B010Wrapper w;

    function setUp() public {
        w = new B010Wrapper();
    }

    function assertUpper(uint256 sol, uint256 refHi, string memory what) internal pure {
        assertGe(sol, refHi, what);
        uint256 tol = refHi / TOL_REL > TOL_ABS ? refHi / TOL_REL : TOL_ABS;
        assertLe(sol - refHi, tol, what);
    }

    // ------------------------------------------------------------------ horizon

    function test_fixtureHorizon() public pure {
        assertEq(HorizonMath.horizonSecsUp(1_000_000, 300, 1000, 0), 360);
        assertEq(HorizonMath.horizonSecsUp(0, 300, 1000, 0), 300);
        assertEq(HorizonMath.horizonSecsUp(1, 300, 1000, 0), 301); // 0.06 s rounds up
        assertEq(HorizonMath.horizonSecsUp(1_000_000, 300, 1000, 45), 405); // queued closeout
    }

    function test_wadHorizonVariants() public pure {
        assertEq(HorizonMath.horizonWadUp(1_000_000, 300, 1000, 0), 360e18);
        assertEq(HorizonMath.horizonWadUp(1, 300, 1000, 0), 300e18 + 6e16); // 0.06 s kept
        assertEq(HazardMath.hazardUpWad(1e14, 360e18), HazardMath.hazardUp(1e14, 360));
        assertEq(
            HorizonMath.sigmaTheoryUpWad(6e17, 360e18, 2505600), HorizonMath.sigmaTheoryUp(6e17, 360, 2505600)
        );
        assertLe(
            HorizonMath.sigmaTheoryUpWad(6e17, 300e18 + 6e16, 2505600),
            HorizonMath.sigmaTheoryUp(6e17, 301, 2505600)
        );
    }

    function test_maxPositionHorizonNoOverflow() public pure {
        uint256 h = HorizonMath.horizonSecsUp(1 << 40, 300, 1000, 0);
        // exact 300 + 2^40 * 60 / (1000 * 1000) = 300 + 65,970,697.67 -> 65,970,998
        assertEq(h, 65970998);
    }

    function test_zeroAbsorptionReverts() public {
        vm.expectRevert(HorizonMath.BadUnits.selector);
        w.horizon(1, 300, 0, 0);
    }

    function testFuzz_horizonMonotone(uint64 a, uint64 b, uint32 queue) public pure {
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        assertLe(
            HorizonMath.horizonSecsUp(lo, 300, 1000, queue), HorizonMath.horizonSecsUp(hi, 300, 1000, queue)
        );
    }

    // ------------------------------------------------------------------ sigma

    function test_sigmaEnclosesReference() public pure {
        assertUpper(HorizonMath.sigmaTheoryUp(6e17, 360, 2505600), 5872202195147035, "fixture sigma");
        assertUpper(HorizonMath.sigmaTheoryUp(1e16, 600, 3600), 40620192023179802, "q 0.01");
        assertUpper(HorizonMath.sigmaTheoryUp(999e15, 301, 86400), 1865559567529271, "q 0.999");
    }

    function test_nearTCapsAtOne() public pure {
        assertEq(HorizonMath.sigmaTheoryUp(5e17, 360, 0), WAD);
        assertEq(HorizonMath.sigmaTheoryUp(5e17, 360, 1), WAD);
        assertEq(HorizonMath.sigmaTheoryUp(5e17, 1, 1), 5e17);
    }

    function test_endpointPriceReverts() public {
        vm.expectRevert(HorizonMath.PriceNotInterior.selector);
        w.sigma(0, 360, 100);
        vm.expectRevert(HorizonMath.PriceNotInterior.selector);
        w.sigma(WAD, 360, 100);
    }

    function testFuzz_sigmaMonotoneInHorizon(uint64 q, uint32 h1, uint32 h2, uint32 secs) public pure {
        uint256 qq = bound(q, 1, WAD - 1);
        (uint256 lo, uint256 hi) = h1 < h2 ? (uint256(h1), uint256(h2)) : (uint256(h2), uint256(h1));
        assertLe(HorizonMath.sigmaTheoryUp(qq, lo, secs), HorizonMath.sigmaTheoryUp(qq, hi, secs));
    }

    function testFuzz_sigmaSquareBracketsRadicand(uint64 q, uint32 h, uint32 secs) public pure {
        uint256 qq = bound(q, 1, WAD - 1);
        uint256 s = HorizonMath.sigmaTheoryUp(qq, h, secs);
        if (s < WAD) {
            uint256 d = secs == 0 ? 1 : secs;
            // s^2 >= q(1-q)h/d exactly (cross-multiplied)
            assertGe(s * s * d, qq * (WAD - qq) * uint256(h));
        }
    }

    // ------------------------------------------------------------------ envelope

    function env3() internal pure returns (HorizonMath.Envelope memory e) {
        e.hSecs = new uint64[](3);
        e.sigmaWad = new uint256[](3);
        (e.hSecs[0], e.hSecs[1], e.hSecs[2]) = (60, 600, 3600);
        (e.sigmaWad[0], e.sigmaWad[1], e.sigmaWad[2]) = (1e16, 2e16, 5e16);
        e.validFrom = 0;
        e.validUntil = 1e9;
    }

    function test_envelopeStepUp() public pure {
        HorizonMath.Envelope memory e = env3();
        (bool ok, uint256 s) = HorizonMath.envelopeAt(e, 1, 5);
        assertTrue(ok);
        assertEq(s, 1e16);
        (, s) = HorizonMath.envelopeAt(e, 61, 5);
        assertEq(s, 2e16);
        (ok,) = HorizonMath.envelopeAt(e, 3601, 5);
        assertFalse(ok, "beyond last bin");
    }

    function test_envelopeRejectsNoisyOrExpired() public pure {
        HorizonMath.Envelope memory e = env3();
        e.sigmaWad[1] = 5e15; // dips
        (bool ok,) = HorizonMath.envelopeAt(e, 100, 5);
        assertFalse(ok);
        e = env3();
        e.validFrom = 10;
        e.validUntil = 20;
        (ok,) = HorizonMath.envelopeAt(e, 100, 9);
        assertFalse(ok);
        (ok,) = HorizonMath.envelopeAt(e, 100, 20);
        assertFalse(ok);
        (ok,) = HorizonMath.envelopeAt(e, 100, 19);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------ hazard / tail / drift

    function test_hazardExactUp() public pure {
        assertEq(HazardMath.hazardUp(1e14, 360), 416666666667);
        assertEq(HazardMath.hazardUp(1e14, 300), 347222222223);
        assertEq(HazardMath.hazardUp(5e15, 86400), 5e15);
        assertEq(HazardMath.hazardUp(1e18, 172800), WAD); // saturates
        assertEq(HazardMath.hazardUp(123456789, 7), 10003);
    }

    function test_tailEnclosesReference() public pure {
        HazardMath.Tail memory t = HazardMath.tail(416666666667, 416666666667, true, EPS);
        assertFalse(t.fullBacking);
        assertLe(t.epsPrimeWad, 9999587499828124);
        assertUpper(t.kWad, 9950081666593604485, "fixture k");
        assertUpper(HazardMath.tail(1e15, 5e15, true, EPS).kWad, 10488088481701515470, "long");
        assertUpper(HazardMath.tail(1e15, 5e15, false, EPS).kWad, 14071247279470288664, "short swap");
        assertUpper(HazardMath.tail(9e15, 0, true, EPS).kWad, 31464265445104546410, "a 0.009");
        assertUpper(HazardMath.tail(99e14, 0, true, EPS).kWad, 99498743710661995474, "a 0.0099");
    }

    function test_fullBackingBranches() public pure {
        HazardMath.Tail memory t = HazardMath.tail(EPS, 0, true, EPS);
        assertTrue(t.fullBacking);
        assertEq(t.reason, HazardMath.ADVERSE_AT_EPSILON);
        assertFalse(HazardMath.tail(EPS, 0, false, EPS).fullBacking, "not adverse for a short");
        t = HazardMath.tail(5e17, 5e17, true, EPS);
        assertEq(t.reason, HazardMath.SUM_AT_LEAST_ONE);
        // Near epsilon: with wad inputs (eps - a) >= 1 wei, so eps' = floor((eps-a) WAD / (WAD-a))
        // is at least 1 and the EPS_PRIME_ZERO branch is defensive only. eps' = 1 wei gives a huge
        // finite k; the margin cap then forces full backing (checked in B011).
        t = HazardMath.tail(EPS - 1, 0, true, EPS);
        assertFalse(t.fullBacking);
        assertEq(t.epsPrimeWad, 1);
        assertGe(t.kWad * t.kWad, (WAD - 1) * WAD * WAD); // k^2 >= (1 - eps')/eps' in wad^2
    }

    function test_badEpsilonReverts() public {
        vm.expectRevert(HazardMath.BadUnits.selector);
        w.tail(0, 0, true, 0);
    }

    function testFuzz_kMonotoneInAdverse(uint64 a, uint64 b) public pure {
        uint256 x = bound(a, 0, EPS - 1);
        uint256 y = bound(b, 0, EPS - 1);
        (uint256 lo, uint256 hi) = x < y ? (x, y) : (y, x);
        HazardMath.Tail memory tl = HazardMath.tail(lo, 0, true, EPS);
        HazardMath.Tail memory th = HazardMath.tail(hi, 0, true, EPS);
        if (!th.fullBacking && !tl.fullBacking) assertLe(tl.kWad, th.kWad);
        if (tl.fullBacking) assertTrue(th.fullBacking, "full backing switch is upward");
    }

    function test_driftEnclosesReference() public pure {
        (bool ok, uint256 m) = HazardMath.driftUp(6e17, 416666666667, 416666666667, true);
        assertTrue(ok);
        assertGe(m, 166666805556 - 1);
        assertLe(m, 166666805556 + 1);
        (, m) = HazardMath.driftUp(6e17, 416666666667, 416666666667, false);
        assertGe(m, 250000208334 - 1);
        (, m) = HazardMath.driftUp(3e17, 1e15, 2e15, true);
        assertEq(m, 1404212637913742);
        (ok,) = HazardMath.driftUp(5e17, 5e17, 5e17, true);
        assertFalse(ok);
    }

    function testFuzz_driftNotBelowSourceDrift(uint64 q, uint64 a0, uint64 a1, bool isLong) public pure {
        uint256 qq = bound(q, 0, WAD);
        uint256 x0 = bound(a0, 0, WAD / 4);
        uint256 x1 = bound(a1, 0, WAD / 4);
        (, uint256 m) = HazardMath.driftUp(qq, x0, x1, isLong);
        // source drift numerator: long a1(1-q) - q a0, short q a0 - a1(1-q); ours drops the negative term
        uint256 favorable = isLong ? qq * x0 : (WAD - qq) * x1;
        uint256 adverse = isLong ? (WAD - qq) * x1 : qq * x0;
        if (adverse > favorable) {
            assertGe(m * (WAD - x0 - x1), adverse - favorable);
        }
    }
}
