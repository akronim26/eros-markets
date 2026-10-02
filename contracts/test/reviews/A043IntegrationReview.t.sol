pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {HaltView} from "../../src/interfaces/IResolutionIngress.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";

contract A043IntegrationReviewTest is CombinedBase {
    function _fundingEpoch() internal returns (uint64 start, uint64 end, int256 rate) {
        _deploy(5, 100_000);
        uint256[] memory allocations = new uint256[](3);
        (allocations[0], allocations[1], allocations[2]) = (700, 400, 100);
        _traders(allocations);
        _activate();
        _keep(L0 + 600, 6e17, false);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 1_000_000);
        uint64 opening = ((L0 + 12 hours) / 1 hours + 1) * 1 hours;
        vm.warp(opening);
        e.feed(opening - 990, opening, 6e17, 61e16, 63e16);
        _roll(32);
        (, start, end,,, rate,) = e.epoch();
        assertGt(rate, 0);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
    }

    function _recover(uint64 from, uint64 until) internal {
        vm.warp(until);
        e.feed(from, until, 6e17, 61e16, 63e16);
        assertTrue(e.riskContext().markOk);
    }

    function _rolloverAfterGap(uint64 lateness) internal {
        (uint64 start, uint64 end, int256 rate) = _fundingEpoch();
        int256 initialIndex = e.fundingFQ();
        _recover(end - 990, end + lateness);
        e.beginRollover();
        assertEq(e.fundingFQ() - initialIndex, rate * 30, "funding stops at the first freshness gap");
        (,,, uint64 accruedUntil, uint64 stop,, bool stopped) = e.epoch();
        assertEq(accruedUntil, start + 30);
        assertEq(stop, start + 30);
        assertTrue(stopped);
        while (!e.rollPage(32)) {}
        _assertInvariants();
    }

    function test_fundingGapAtEpochEndCannotBeErasedByFreshMark() public {
        _rolloverAfterGap(0);
    }

    function test_fundingGapAfterEpochEndCannotBeErasedByFreshMark() public {
        _rolloverAfterGap(1000);
    }

    function test_directAccountingActionsDoNotRestartFundingAfterRecovery() public {
        (uint64 start,, int256 rate) = _fundingEpoch();
        int256 initialIndex = e.fundingFQ();
        _recover(start + 100, start + 1100);
        assertEq(e.fundingFQ() - initialIndex, rate * 30);
        vm.prank(_who(3));
        e.release(1e6);
        _fund(_who(3), 1e6, false);
        _fund(LP, 1e6, true);
        assertEq(e.fundingFQ() - initialIndex, rate * 30);
        _assertInvariants();
    }

    function test_staleAccrualPreviewMatchesFundingStopAndPremiumTouch() public {
        (uint64 start,, int256 rate) = _fundingEpoch();
        vm.prank(_who(1));
        e.release(570e6);
        int256 cashBefore = _cash(1);
        vm.warp(start + 60);
        TradePreview.AccountPreview memory preview = e.previewAccount(1);
        assertEq(preview.projectedFundingQ, rate * 30 * 1_000_000);
        assertGt(preview.projectedPremiumQ, 0);
        assertEq(preview.cashQ, cashBefore - preview.projectedFundingQ - int256(preview.projectedPremiumQ));
        e.cancelAll(1);
        assertEq(_cash(1), preview.cashQ);
        assertEq(e.previewAccount(1).projectedPremiumQ, 0);
        _assertInvariants();
    }

    function test_negativeCashReleasePreviewMatchesExecutionAfterAccrual() public {
        (uint64 start,,) = _fundingEpoch();
        vm.prank(_who(1));
        e.release(570e6);
        _recover(start + 100, start + 1100);
        TradePreview.AccountPreview memory preview = e.previewAccount(1);
        assertLt(preview.cashQ, 0);
        assertGt(preview.usableReleaseAtoms, 0);
        (bool accepted,) = e.previewRelease(1, preview.usableReleaseAtoms);
        assertTrue(accepted);
        (bool excessive,) = e.previewRelease(1, preview.usableReleaseAtoms + 1);
        assertFalse(excessive);
        vm.startPrank(_who(1));
        vm.expectRevert();
        e.release(preview.usableReleaseAtoms + 1);
        e.release(preview.usableReleaseAtoms);
        vm.stopPrank();
        assertEq(_cash(1), preview.cashQ - int256(preview.usableReleaseAtoms * Q));
        _assertInvariants();
    }

    function test_earlyHaltReportsActualFrozenMarketEpoch() public {
        _fundingEpoch();
        HaltView memory snapshot = oracle.haltEarly();
        assertEq(snapshot.frozenBookEpoch, e.marketOrderEpoch());
        assertEq(e.getHaltSnapshot().frozenBookEpoch, e.marketOrderEpoch());
    }

    function test_haltDuringRolloverReportsActualFrozenMarketEpoch() public {
        (, uint64 end,) = _fundingEpoch();
        vm.warp(end);
        e.beginRollover();
        e.rollPage(1);
        HaltView memory snapshot = oracle.haltEarly();
        assertEq(snapshot.frozenBookEpoch, e.marketOrderEpoch());
    }

    function test_scheduledHaltReportsActualFrozenMarketEpoch() public {
        _fundingEpoch();
        vm.warp(T);
        HaltView memory snapshot = e.materializeScheduledHalt();
        assertEq(snapshot.frozenBookEpoch, e.marketOrderEpoch());
    }
}
