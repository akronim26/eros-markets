// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {QMath} from "../../src/math/QMath.sol";
import {LedgerMath as L} from "../../src/math/LedgerMath.sol";
import {CoverageMath as C} from "../../src/math/CoverageMath.sol";
import {FundingMath} from "../../src/math/FundingMath.sol";
import {PricingMath} from "../../src/math/PricingMath.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

/// @notice G1 — reference engines and numeric primitives joined. The combined reference trace is
///         reference/integration/combined_trace.py (tested by reference/tests/integration/test_g1.py).
///         Here: QMath directed bounds against exact rational definitions, and the trace's
///         primitive values replayed through the frozen A and B Solidity libraries.
contract G1Test is Test {
    uint256 constant USDC = 1e24;

    function test_mulDivDirected(uint128 x, uint128 y, uint128 d) public pure {
        vm.assume(d != 0);
        uint256 p = uint256(x) * uint256(y); // exact product (fits)
        assertEq(QMath.mulDiv(x, y, d), p / d);
        assertEq(QMath.mulDivUp(x, y, d), p / d + (p % d == 0 ? 0 : 1));
    }

    function test_sqrtUpDirected(uint128 x) public pure {
        uint256 r = QMath.sqrtUp(x);
        assertGe(r * r, uint256(x));
        if (r != 0) assertLt((r - 1) * (r - 1), uint256(x));
    }

    function test_signedDivisionDirected(int128 a, int128 b) public pure {
        vm.assume(b != 0);
        int256 f = QMath.floorDiv(a, b);
        int256 c = QMath.ceilDiv(a, b);
        // f <= a/b < f + 1 and c - 1 < a/b <= c, checked by cross-multiplication.
        if (b > 0) {
            assertLe(f * b, int256(a));
            assertGt((f + 1) * b, int256(a));
            assertGe(c * b, int256(a));
            assertLt((c - 1) * b, int256(a));
        } else {
            assertGe(f * b, int256(a));
            assertLt((f + 1) * b, int256(a));
            assertLe(c * b, int256(a));
            assertGt((c - 1) * b, int256(a));
        }
        assertLe(c - f, 1);
    }

    /// Replay of reference/integration/combined_trace.py steps 2-4 on the Solidity libraries.
    function test_combinedTraceReplay() public pure {
        (L.Value memory alice, L.Value memory bob) =
            L.fill(L.Value(0, int256(120 * USDC)), L.Value(0, int256(400 * USDC)), 1_000_000, 600, 0, 0);
        assertEq(alice.cashQ, -int256(480 * USDC));
        assertEq(bob.cashQ, int256(1000 * USDC));
        C.Orders memory none;
        (uint256 d0,) = C.deficits(alice, none);
        assertEq(d0, 480 * USDC);
        (int256 s0, int256 s1) = C.slacks(L.Value(0, int256(100_000 * USDC)), d0, 0, 0, 0);
        assertEq(s0, int256(99_520 * USDC));
        assertEq(s1, int256(100_000 * USDC));
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, true, 6e17, 29 days, 0, RiskFixture.profile(5, true));
        assertEq(m.imQ, 120 * USDC);
        int256 r = FundingMath.rate(0.62e18, 0.6e18);
        assertEq(r, 231_481_481_481_481);
        assertEq(PricingMath.fundingRate(0.62e18, 0.6e18), r);
        FundingMath.Delta memory fd = FundingMath.advance(600, r, 1_000_000, 0, type(uint128).max);
        assertEq(fd.indexQ, 138_888_888_888_888_600);
        assertEq(fd.traderPayerQ, 1_000_000 * uint256(fd.indexQ));
    }
}
