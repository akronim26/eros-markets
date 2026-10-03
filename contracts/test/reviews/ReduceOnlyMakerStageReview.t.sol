pragma solidity ^0.8.30;

import {RealBookPolicyReviewBase} from "./BootstrapPriceBandReview.t.sol";
import {Stage} from "../../src/math/RiskTypes.sol";

contract ReduceOnlyMakerStageReviewTest is RealBookPolicyReviewBase {
    function _openPosition() private {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        _place(MAKER, false, 500, 100_000, false, true);
        _place(TAKER, true, 500, 100_000, false, false);
        assertEq(engine.account(MAKER).value.lots, -100_000);
        assertEq(engine.account(TAKER).value.lots, 100_000);
    }

    function _assertOrdinaryMakerPruned(uint32 restingBid) private {
        assertEq(uint8(engine.currentStage()), uint8(Stage.REDUCE_ONLY));
        _place(TAKER, false, 500, 50_000, true, false);
        assertEq(engine.getOrder(restingBid).size, 0);
        assertEq(engine.account(OTHER).value.lots, 0);
        assertEq(engine.account(OTHER).orders.bidLots, 0);
        assertEq(engine.account(MAKER).value.lots, -100_000);
        assertEq(engine.account(TAKER).value.lots, 100_000);
        assertEq(engine.oiAllLots(), 100_000);
        _assertConservation();
    }

    function testMonitorReduceOnlyPrunesPreviouslyAdmittedOrdinaryMaker() public {
        _openPosition();
        uint32 restingBid = _place(OTHER, true, 500, 50_000, false, true);
        assertGt(restingBid, 0);
        vm.prank(MONITOR);
        engine.requestReduceOnly(bytes32("review-restriction"));
        _assertOrdinaryMakerPruned(restingBid);
    }

    function testScheduledReduceOnlyPrunesCurrentEpochOrdinaryMaker() public {
        _openPosition();
        uint64 beforeRestriction = engine.scheduledT() - 1 hours - 60;
        _indexOnly(beforeRestriction - 300, beforeRestriction, 5e17);
        engine.beginRollover();
        assertTrue(engine.rollPage(32));
        engine.finishRollover();
        engine.floorSweep(32);
        assertTrue(engine.floorReconciled());
        assertEq(uint8(engine.currentStage()), uint8(Stage.BACKING_FLOOR));
        uint32 restingBid = _place(OTHER, true, 500, 50_000, false, true);
        assertGt(restingBid, 0);
        uint64 restingEpoch = engine.marketOrderEpoch();
        _indexOnly(beforeRestriction + 10, beforeRestriction + 60, 5e17);
        assertEq(engine.marketOrderEpoch(), restingEpoch);
        _assertOrdinaryMakerPruned(restingBid);
    }

    function testTradingStageStillAllowsOrdinaryMakerExposure() public {
        _openPosition();
        uint32 restingBid = _place(OTHER, true, 500, 50_000, false, true);
        assertEq(uint8(engine.currentStage()), uint8(Stage.TRADING));
        _place(TAKER, false, 500, 50_000, true, false);
        assertEq(engine.getOrder(restingBid).size, 0);
        assertEq(engine.account(OTHER).value.lots, 50_000);
        assertEq(engine.account(TAKER).value.lots, 50_000);
        assertEq(engine.account(MAKER).value.lots, -100_000);
        _assertConservation();
    }

    function testReduceOnlyMakerAndTakerCanBothReduceUnderMonitorRestriction() public {
        _openPosition();
        uint32 reducingBid = _place(MAKER, true, 500, 50_000, true, true);
        assertGt(reducingBid, 0);
        vm.prank(MONITOR);
        engine.requestReduceOnly(bytes32("review-restriction"));
        _place(TAKER, false, 500, 50_000, true, false);
        assertEq(engine.getOrder(reducingBid).size, 0);
        assertEq(engine.account(MAKER).value.lots, -50_000);
        assertEq(engine.account(TAKER).value.lots, 50_000);
        assertEq(engine.account(OTHER).value.lots, 0);
        assertEq(engine.oiAllLots(), 50_000);
        _assertConservation();
    }
}
