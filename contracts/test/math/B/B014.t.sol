// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {LifecycleMath as LC} from "../../../src/math/LifecycleMath.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {Stage, PricingMode, FinalOutcome} from "../../../provisional/MathTypes.sol";
import {RiskFixture} from "./B011.t.sol";

contract B014Wrapper {
    function accept(FinalOutcome a, FinalOutcome b) external pure returns (FinalOutcome, bool) {
        return LC.acceptFinality(a, b);
    }

    function fromY(uint8 y) external pure returns (FinalOutcome) {
        return LC.outcomeFromY(y);
    }

    function pacing(uint256 r, uint256 e) external pure returns (uint256, bool) {
        return LM.pacing(r, e, true, 10);
    }
}

/// B014: liquidation and clock predicates against B008/B009 reference results.
contract B014Test is Test {
    uint256 constant Q = 1e18;
    uint256 constant USDC = 1e24;
    uint256 constant QW = 6e17;
    B014Wrapper w;

    function setUp() public {
        w = new B014Wrapper();
    }

    function snapOf(int256 cashQ, int256 lots) internal pure returns (LM.Snap memory s) {
        uint256 n = lots >= 0 ? uint256(lots) : uint256(-lots);
        MarginMath.Margin memory m =
            MarginMath.sideMargin(n, lots > 0, QW, 29 days, 0, RiskFixture.profile(5, true));
        (s.e0Q, s.e1Q) = MarginMath.endpoints(cashQ, lots);
        s.emQ = MarginMath.markEquityQ(cashQ, lots, QW);
        s.mmQ = m.mmQ;
        s.xLots = lots;
    }

    // ------------------------------------------------------------------ takeover vs work

    function test_zeroEquityTakeover() public pure {
        LM.Snap memory s = snapOf(-int256(600 * USDC), 1_000_000);
        assertEq(s.emQ, 0);
        assertTrue(LM.authorizeTakeover(true, false, s.e0Q, s.e1Q, s.emQ));
        assertEq(
            uint8(LM.eligibility(true, false, false, s.e0Q, s.e1Q, s.emQ, s.mmQ, 0)), uint8(LM.Mode.TAKEOVER)
        );
    }

    function test_positiveEquityNeverTakeoverFromWork() public pure {
        LM.Snap memory s = snapOf(-int256(540 * USDC), 1_000_000); // E = 60 < MM
        assertFalse(LM.authorizeTakeover(true, false, s.e0Q, s.e1Q, s.emQ));
        assertEq(
            uint8(LM.eligibility(true, false, false, s.e0Q, s.e1Q, s.emQ, s.mmQ, 120 * USDC)),
            uint8(LM.Mode.REDUCE)
        );
        // one lot closed, still unhealthy, positive equity -> NEEDS_MORE_WORK
        assertEq(uint8(LM.continuation(false, 999_999, s.emQ)), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(uint8(LM.continuation(true, 477_071, s.emQ)), uint8(LM.Result.DONE));
        assertEq(uint8(LM.continuation(false, 0, s.emQ)), uint8(LM.Result.DONE));
    }

    function test_staleMarkAndFloor() public pure {
        assertEq(uint8(LM.eligibility(false, false, false, 1, 5, 1, 10, 20)), uint8(LM.Mode.NONE));
        assertTrue(LM.authorizeTakeover(false, true, -1, 5, 0));
        assertFalse(LM.authorizeTakeover(false, false, -1, 5, 0));
        assertTrue(LM.authorizeTakeover(false, false, -3, 0, 0));
        assertFalse(LM.authorizeTakeover(false, false, 0, 0, 0));
    }

    function test_graceEligibility() public pure {
        assertEq(uint8(LM.eligibility(true, false, false, 1, 1, 100, 60, 120)), uint8(LM.Mode.NONE));
        assertEq(uint8(LM.eligibility(true, false, true, 1, 1, 100, 60, 120)), uint8(LM.Mode.REDUCE));
    }

    function test_pacing() public {
        (uint256 a, bool d) = LM.pacing(100, 5, false, 1000);
        assertTrue(d);
        assertEq(a, 0);
        (a, d) = LM.pacing(100, 5, true, 40);
        assertEq(a, 40);
        vm.expectRevert(LM.ZeroWorkBudget.selector);
        w.pacing(0, 5);
        vm.expectRevert(LM.ZeroWorkBudget.selector);
        w.pacing(5, 0);
    }

    // ------------------------------------------------------------------ estimate / bankruptcy

    function test_estimateMatchesReference() public pure {
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        (uint256 lots, bool full) = LM.sizeEstimateLots(m.imQ, int256(60 * USDC), 1_000_000, 5e15, 1e12);
        assertFalse(full);
        // reference/b/liquidation.py: 522,929 lots (exact sqrt bracket); integer sqrtDown may add one lot
        assertGe(lots, 522_929);
        assertLe(lots, 522_930);
    }

    function test_estimateInvalidRootsFullClose() public pure {
        (uint256 lots, bool full) = LM.sizeEstimateLots(100 * USDC, int256(150 * USDC), 1000, 5e15, 1e12);
        assertTrue(full);
        assertEq(lots, 1000);
        (lots, full) = LM.sizeEstimateLots(1 * USDC, 0, 1_000_000, 1e16, 1e12);
        assertTrue(full);
        (lots, full) = LM.sizeEstimateLots(100 * USDC, 0, 1_000_000, 0, 1e18);
        assertTrue(full);
        (lots, full) = LM.sizeEstimateLots(0, 0, 0, 5e15, 1e12);
        assertEq(lots, 0);
    }

    function test_candidateRecheckedAgainstActualMargin() public pure {
        // Apply the estimate at tick 600 with the one-atom-per-lot fee and recheck with the
        // size-dependent MM of the remaining position: the allowed-reduction predicate holds.
        LM.Snap memory b = snapOf(-int256(540 * USDC), 1_000_000);
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, true, QW, 29 days, 0, RiskFixture.profile(5, true));
        (uint256 n,) = LM.sizeEstimateLots(m.imQ, b.emQ, 1_000_000, 5e15, 1e12);
        int256 rem = 1_000_000 - int256(n);
        LM.Snap memory noFee = snapOf(-int256(540 * USDC) + int256(n * 600 * Q), rem);
        int256 th = LM.thresholdQ(noFee.mmQ, b.emQ, b.mmQ);
        uint256 fee = LM.feeAllowedQ(n, b, noFee, th);
        assertEq(fee, n * Q, "full fee affordable here");
        LM.Snap memory a = snapOf(-int256(540 * USDC) + int256(n * 600 * Q) - int256(fee), rem);
        assertTrue(LM.allowedReduction(b, a));
        MarginMath.Margin memory ma =
            MarginMath.sideMargin(uint256(rem), true, QW, 29 days, 0, RiskFixture.profile(5, true));
        assertGe(a.emQ, int256(ma.imQ), "reference: DONE after one estimate");
    }

    function test_goldenBankruptcyLong() public pure {
        (uint16 t, bool ok) = LM.bankruptcyTick(1_000_000, 1_000_000, -int256(540 * USDC), QW, 1 * USDC, 0);
        assertTrue(ok);
        assertEq(t, 541);
    }

    function test_bankruptcyShortAndPartial() public pure {
        (uint16 t, bool ok) = LM.bankruptcyTick(-1_000_000, 1_000_000, int256(640 * USDC), QW, 1 * USDC, 0);
        assertTrue(ok);
        assertEq(t, 639);
        (t, ok) = LM.bankruptcyTick(2000, 1000, -int256(11e5 * Q), QW, 0, 0);
        assertEq(t, 500);
        (, ok) = LM.bankruptcyTick(1000, 1000, -int256(2 * USDC), QW, 0, 0);
        assertFalse(ok);
    }

    function test_feeWaiver() public pure {
        LM.Snap memory b = LM.Snap(1000, 10, 10, 100, 50);
        assertEq(LM.feeAllowedQ(500, b, LM.Snap(500, 10, 10, 60, 20), 55), 5);
        assertEq(LM.feeAllowedQ(500, b, LM.Snap(500, 10, 10, 60, 20), 60), 0);
        assertEq(LM.feeAllowedQ(3, b, LM.Snap(500, 1e30, 1e30, 1e30, 0), 0), 3 * Q);
    }

    function test_predicateRules() public pure {
        LM.Snap memory b = LM.Snap(10, -5, 20, 30, 20);
        assertTrue(LM.allowedReduction(b, LM.Snap(5, -5, 10, 28, 10)));
        assertFalse(LM.allowedReduction(b, LM.Snap(10, -5, 10, 28, 10)));
        assertFalse(LM.allowedReduction(b, LM.Snap(-2, -5, 10, 28, 10)));
        assertFalse(LM.allowedReduction(b, LM.Snap(5, -6, 10, 28, 10)));
        assertFalse(LM.allowedReduction(b, LM.Snap(5, -5, 10, -1, 0)));
        assertFalse(LM.allowedReduction(b, LM.Snap(5, -5, 10, 15, 16)));
        assertFalse(LM.allowedReduction(LM.Snap(10, 0, 0, 0, 5), LM.Snap(5, 0, 0, 0, 1)));
    }

    function test_pairTick() public pure {
        assertEq(LM.pairTick(6004e14), 600);
        assertEq(LM.pairTick(5e14), 1);
        assertEq(LM.pairTick(9999e14), 999);
        assertEq(LM.pairTick(0), 1);
    }

    // ------------------------------------------------------------------ clock

    function test_stageBoundaries() public pure {
        uint256 T = 1_000_000;
        uint256[8] memory ts = [uint256(954999), 955000, 956799, 956800, 996399, 996400, 999999, 1000000];
        Stage[8] memory st = [
            Stage.TRADING,
            Stage.BACKING_GRACE,
            Stage.BACKING_GRACE,
            Stage.BACKING_FLOOR,
            Stage.BACKING_FLOOR,
            Stage.REDUCE_ONLY,
            Stage.REDUCE_ONLY,
            Stage.HALTED
        ];
        for (uint256 i; i < 8; ++i) {
            assertEq(uint8(LC.deriveStage(ts[i], T, 0, false, false).stage), uint8(st[i]));
        }
        assertEq(uint8(LC.deriveStage(0, T, 0, true, false).stage), uint8(Stage.REDUCE_ONLY));
        assertEq(uint8(LC.deriveStage(500, T, 400, false, false).stage), uint8(Stage.HALTED));
        assertEq(uint8(LC.deriveStage(T, T, 0, false, true).stage), uint8(Stage.CLAIMS_READY));
        assertEq(uint8(LC.deriveStage(5, T, 0, false, true).stage), uint8(Stage.TRADING));
    }

    function test_haltRollOrderSameCutoff() public pure {
        uint256[4] memory halts = [uint256(5000), 7200, 9000, 30000];
        for (uint256 i; i < 4; ++i) {
            uint256 a = LC.accrualCutoff(halts[i], 7200, 0);
            uint256 b = LC.accrualCutoff(halts[i], 7200, 7200);
            assertEq(a, b);
        }
        assertEq(LC.economicHaltAt(1e6, 0), 1e6);
        assertEq(LC.economicHaltAt(1e6, 1e6 + 500), 1e6);
        assertEq(LC.economicHaltAt(1e6, 1e6 - 500), 1e6 - 500);
    }

    function test_fundingCutoff() public pure {
        uint256 T = 1e6;
        LC.FundingCutoffInputs memory i = LC.FundingCutoffInputs(T - 50000, T - 49000, T, 0, T - 49500, 0, 0);
        assertEq(LC.fundingCutoff(i), T - 50000);
        i.nowTs = T - 49200;
        assertEq(LC.fundingCutoff(i), T - 49500);
        (i.nowTs, i.activeEpochEnd, i.fundingFreshThrough) = (T, T, T);
        assertEq(LC.fundingCutoff(i), T - 43200);
        i.haltAt = T - 51000;
        assertEq(LC.fundingCutoff(i), T - 51000);
    }

    function test_grace() public pure {
        LC.GraceState memory g = LC.graceOnTouch(LC.GraceState(false, 0), true, 1000);
        g = LC.graceOnTouch(g, true, 4600);
        g = LC.graceOnTouch(g, true, 8200);
        assertEq(g.anchor, 1000, "touch cannot reset");
        assertTrue(LC.graceExpired(g, 3600, 4600, 1e6, false));
        assertFalse(LC.graceExpired(g, 3600, 4599, 1e6, false));
        assertTrue(LC.graceExpired(LC.GraceState(false, 0), 3600, 0, 1e6, true), "below MM no grace");
        assertFalse(LC.graceOnTouch(g, false, 9000).active);
        assertTrue(LC.graceExpired(LC.GraceState(true, uint64(1e6 - 44000)), 3600, 1e6 - 43200, 1e6, false));
    }

    function test_bootstrap() public pure {
        (PricingMode m, LC.Admission a) =
            LC.pricingTransition(PricingMode.BOOTSTRAP, false, true, true, true, true, false);
        assertEq(uint8(m), uint8(PricingMode.BOOTSTRAP));
        assertEq(uint8(a), uint8(LC.Admission.BACKED_ONLY));
        (m, a) = LC.pricingTransition(PricingMode.BOOTSTRAP, true, true, true, true, true, false);
        assertEq(uint8(m), uint8(PricingMode.NORMAL_PRICING));
        assertEq(uint8(a), uint8(LC.Admission.LEVERAGED));
        (, a) = LC.pricingTransition(PricingMode.NORMAL_PRICING, false, true, true, false, true, false);
        assertEq(uint8(a), uint8(LC.Admission.BACKED_ONLY));
        (, a) = LC.pricingTransition(PricingMode.BOOTSTRAP, true, true, true, true, true, true);
        assertEq(uint8(a), uint8(LC.Admission.NONE), "bootstrap cannot override a halt");
    }

    function test_earlyInvalidWaits() public pure {
        uint256 T = 5_000_000;
        assertEq(
            uint8(LC.invalidReadiness(4_568_000, T, true, true, 3600)), uint8(LC.InvalidReadiness.NOT_YET)
        );
        assertEq(uint8(LC.invalidReadiness(T, T, true, true, 3600)), uint8(LC.InvalidReadiness.CAPTURE_TWAP));
        assertEq(
            uint8(LC.invalidReadiness(T + 3599, T, false, true, 3600)), uint8(LC.InvalidReadiness.WAIT_GRACE)
        );
        assertEq(
            uint8(LC.invalidReadiness(T + 3600, T, false, true, 3600)),
            uint8(LC.InvalidReadiness.CAPTURE_FALLBACK)
        );
        assertEq(
            uint8(LC.invalidReadiness(T + 3600, T, false, false, 3600)), uint8(LC.InvalidReadiness.BLOCKED)
        );
        (uint256 s, uint256 e) = LC.invalidWindow(T);
        assertEq(s, T - 86400);
        assertEq(e, T);
        assertTrue(LC.listingValid(0, 1 days, 3600, 30 days));
        assertFalse(LC.listingValid(0, 1 days - 1, 3600, 30 days));
        assertTrue(LC.listingValid(0, 30 days - 3600, 3600, 30 days));
        assertFalse(LC.listingValid(0, 30 days - 3599, 3600, 30 days));
    }

    function test_finality() public {
        (FinalOutcome o, bool n) = LC.acceptFinality(FinalOutcome.UNSET, FinalOutcome.YES);
        assertEq(uint8(o), uint8(FinalOutcome.YES));
        assertTrue(n);
        (o, n) = LC.acceptFinality(o, FinalOutcome.YES);
        assertFalse(n);
        vm.expectRevert(LC.ConflictingFinalOutcome.selector);
        w.accept(FinalOutcome.YES, FinalOutcome.NO);
        vm.expectRevert(LC.BadOutcome.selector);
        w.fromY(2);
        assertEq(uint8(LC.outcomeFromY(1)), uint8(FinalOutcome.YES));
        assertEq(uint8(LC.outcomeFromY(0)), uint8(FinalOutcome.NO));
    }

    function test_claimsStatus() public pure {
        assertEq(
            uint8(LC.claimsStatus(FinalOutcome.INVALID, false, true, true, true)),
            uint8(LC.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING)
        );
        assertEq(
            uint8(LC.claimsStatus(FinalOutcome.YES, true, true, false, true)),
            uint8(LC.ClaimsStatus.ORACLE_FINAL_PREPARING)
        );
        assertEq(
            uint8(LC.claimsStatus(FinalOutcome.YES, true, true, true, false)),
            uint8(LC.ClaimsStatus.RECOVERY_REQUIRED)
        );
        assertEq(
            uint8(LC.claimsStatus(FinalOutcome.YES, true, true, true, true)), uint8(LC.ClaimsStatus.CLAIMABLE)
        );
        assertEq(
            uint8(LC.claimsStatus(FinalOutcome.UNSET, true, true, true, true)),
            uint8(LC.ClaimsStatus.AWAITING_OUTCOME)
        );
    }
}
