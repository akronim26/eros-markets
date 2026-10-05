pragma solidity ^0.8.30;

import {RealBookPolicyReviewBase} from "./BootstrapPriceBandReview.t.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {Stage, RejectCode} from "../../src/math/RiskTypes.sol";

contract ReduceOnlyReleasePolicyTest is RealBookPolicyReviewBase {
    function _openPositions() private {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        _place(MAKER, false, 500, 100_000, false, true);
        _place(TAKER, true, 500, 100_000, false, false);
        assertEq(engine.account(MAKER).value.lots, -100_000);
        assertEq(engine.account(TAKER).value.lots, 100_000);
    }

    function _restrictByMonitor() private {
        vm.prank(MONITOR);
        engine.requestReduceOnly(bytes32("release-policy"));
        assertEq(uint8(engine.currentStage()), uint8(Stage.REDUCE_ONLY));
    }

    function _restrictByTime() private {
        uint64 beforeRestriction = engine.scheduledT() - 1 hours - 60;
        _indexOnly(beforeRestriction - 300, beforeRestriction, 5e17);
        engine.beginRollover();
        assertTrue(engine.rollPage(32));
        engine.finishRollover();
        engine.floorSweep(32);
        assertTrue(engine.floorReconciled());
        _indexOnly(beforeRestriction + 10, beforeRestriction + 60, 5e17);
        assertEq(uint8(engine.currentStage()), uint8(Stage.REDUCE_ONLY));
    }

    function _assertRelease(address owner, uint256 atoms) private {
        int256 cashBefore = engine.account(owner).value.cashQ;
        int128 lotsBefore = engine.account(owner).value.lots;
        uint256 freeBefore = vault.freeAtoms(owner);
        uint256 allocationBefore = vault.marketAtoms(address(engine));
        (bool allowed, RejectCode reason) = engine.previewRelease(engine.participantId(owner), atoms);
        assertTrue(allowed);
        assertEq(uint8(reason), uint8(RejectCode.NONE));
        vm.prank(owner);
        engine.release(atoms);
        assertEq(engine.account(owner).value.cashQ, cashBefore - int256(atoms * 1e18));
        assertEq(engine.account(owner).value.lots, lotsBefore);
        assertEq(vault.freeAtoms(owner), freeBefore + atoms);
        assertEq(vault.marketAtoms(address(engine)), allocationBefore - atoms);
        assertEq(token.balanceOf(address(vault)), 300e6);
        (int256 slackNo, int256 slackYes) = engine.coverageSlacks();
        assertGe(slackNo, 0);
        assertGe(slackYes, 0);
    }

    function _assertRejectedRelease(address owner, uint256 atoms, RejectCode expected, bytes4 revertCode)
        private
    {
        bytes32 accountBefore = keccak256(abi.encode(engine.account(owner)));
        uint256 freeBefore = vault.freeAtoms(owner);
        uint256 allocationBefore = vault.marketAtoms(address(engine));
        (bool allowed, RejectCode reason) = engine.previewRelease(engine.participantId(owner), atoms);
        assertFalse(allowed);
        assertEq(uint8(reason), uint8(expected));
        vm.prank(owner);
        vm.expectRevert(revertCode);
        engine.release(atoms);
        assertEq(keccak256(abi.encode(engine.account(owner))), accountBefore);
        assertEq(vault.freeAtoms(owner), freeBefore);
        assertEq(vault.marketAtoms(address(engine)), allocationBefore);
    }

    function testMonitorReduceOnlyAllowsFlatAccountExcessRelease() public {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        _restrictByMonitor();
        _assertRelease(OTHER, 100e6);
        assertEq(engine.account(OTHER).value.cashQ, 0);
    }

    function testMonitorReduceOnlyAllowsLongAndShortExcessRelease() public {
        _openPositions();
        _restrictByMonitor();
        _assertRelease(TAKER, 50e6);
        _assertRelease(MAKER, 50e6);
        assertEq(engine.account(TAKER).value.cashQ, 0);
        assertEq(engine.account(MAKER).value.cashQ, 100e24);
    }

    function testScheduledReduceOnlyAllowsFlatAccountExcessRelease() public {
        _restrictByTime();
        _assertRelease(OTHER, 100e6);
    }

    function testScheduledReduceOnlyAllowsLongAndShortExcessRelease() public {
        _openPositions();
        _restrictByTime();
        _assertRelease(TAKER, 50e6);
        _assertRelease(MAKER, 50e6);
    }

    function testReduceOnlyReleaseKeepsOrderAwareBackingRequirement() public {
        _openPositions();
        uint32 restingBid = _place(TAKER, true, 500, 50_000, false, true);
        assertGt(restingBid, 0);
        _restrictByMonitor();
        _assertRejectedRelease(TAKER, 25e6 + 1, RejectCode.MARKET_COVERAGE, RiskStorage.Rejected.selector);
        _assertRelease(TAKER, 25e6);
        assertEq(engine.getOrder(restingBid).size, 50_000);
        assertEq(engine.account(TAKER).orders.bidLots, 50_000);
        assertEq(engine.account(TAKER).value.cashQ, 25e24);
    }

    function testStalePricesRejectMarketReleaseButNotFreeVaultWithdrawal() public {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        _restrictByMonitor();
        _assertRelease(OTHER, 10e6);
        vm.warp(OPENING + 31);
        assertFalse(engine.riskContext().indexOk);
        assertFalse(engine.riskContext().markOk);
        _assertRejectedRelease(OTHER, 1e6, RejectCode.INVALID_PRICE_OR_SIZE, RiskStorage.Rejected.selector);
        vm.prank(OTHER);
        vault.withdraw(10e6);
        assertEq(token.balanceOf(OTHER), 10e6);
        assertEq(vault.freeAtoms(OTHER), 0);
        assertEq(vault.marketAtoms(address(engine)), 290e6);
        assertEq(token.balanceOf(address(vault)), 290e6);
        assertEq(engine.account(OTHER).value.cashQ, 90e24);
    }

    function testReduceOnlyReleaseStillWaitsForAccountingRollover() public {
        _indexOnly(OPENING - 300, OPENING, 5e17);
        _restrictByMonitor();
        (,, uint64 epochEnd,,,,) = engine.epoch();
        _indexOnly(epochEnd - 300, epochEnd, 5e17);
        _assertRejectedRelease(OTHER, 1e6, RejectCode.BAD_STAGE, RiskStorage.BadState.selector);
    }
}
