pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {HaltView} from "../../src/interfaces/IResolutionIngress.sol";
import {ClearingPhase} from "../../src/math/RiskTypes.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {RiskContextPort} from "../../src/risk/RiskContextPort.sol";
import {ReserveVault} from "../../src/vaults/ReserveVault.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {ResolutionIngress} from "../../src/settlement/ResolutionIngress.sol";

contract PreActivationExitTest is CombinedBase {
    function testEarlyAuthenticatedHaltReturnsTraderAndReserveCash() public {
        _deploy(1, 1000);
        _fund(_who(1), 100e6, false);
        vm.warp(L0 + 2 days);
        vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
        e.halt();
        vm.expectRevert(ResolutionIngress.ScheduledHaltNotYet.selector);
        e.materializeScheduledHalt();
        HaltView memory halt = oracle.haltEarly();
        _assertStoppedEpoch(L0 + 2 days, halt);
        assertTrue(oracle.finalize(1));
        _prepareClaims();
        assertEq(e.claimTrader(_who(1)), 100e6);
        assertEq(token.balanceOf(_who(1)), 100e6);
        ReserveVault reserveVault = e.reserveVault();
        vm.prank(LP);
        reserveVault.notice();
        vm.expectRevert(ReserveVault.Locked.selector);
        e.redeemReserve(LP);
        vm.warp(L0 + 9 days);
        assertEq(e.redeemReserve(LP), 1000e6);
        assertEq(vault.claim(address(e), LP), 1000e6);
        assertEq(token.balanceOf(LP), 1000e6);
        _assertFullyExited();
    }

    function testEmptyUnactivatedMarketCompletesSettlement() public {
        _deploy(1, 0);
        vm.warp(T);
        HaltView memory halt = e.materializeScheduledHalt();
        _assertStoppedEpoch(T, halt);
        assertEq(halt.frozenAccountCount, 0);
        assertTrue(oracle.finalize(2));
        _prepareClaims();
        assertEq(e.totalTraderAtoms(), 0);
        assertEq(e.outstandingReserveAtoms(), 0);
        _assertFullyExited();
    }

    function testOnlyReserveSeedExitsAfterSevenDayNotice() public {
        _deploy(1, 777);
        vm.warp(T + 1);
        assertTrue(oracle.finalize(1));
        _assertStoppedEpoch(T, e.getHaltSnapshot());
        assertEq(e.participantCount(), 0);
        _prepareClaims();
        assertEq(e.outstandingReserveAtoms(), 777e6);
        assertEq(e.unpaidTraderClaims(), 0);
        ReserveVault reserveVault = e.reserveVault();
        vm.prank(LP);
        reserveVault.notice();
        uint256 redemptionAt = block.timestamp + 7 days;
        vm.warp(redemptionAt - 1);
        vm.expectRevert(ReserveVault.Locked.selector);
        e.redeemReserve(LP);
        vm.warp(redemptionAt);
        assertEq(e.redeemReserve(LP), 777e6);
        assertEq(vault.claim(address(e), LP), 777e6);
        assertEq(token.balanceOf(LP), 777e6);
        vm.expectRevert(ReserveVault.Locked.selector);
        e.redeemReserve(LP);
        _assertFullyExited();
    }

    function testTraderWithoutReserveSeedExitsAfterDelayedSnapshot() public {
        _deploy(1, 0);
        _fund(_who(1), 99e6 + 1, false);
        vm.warp(L0 + 13 days);
        assertTrue(oracle.finalize(2));
        _assertStoppedEpoch(L0 + 13 days, e.getHaltSnapshot());
        vm.warp(T + 30 days);
        _prepareClaims();
        assertEq(e.traderAtoms(_who(1)), 99e6 + 1);
        assertEq(e.claimTrader(_who(1)), 99e6 + 1);
        assertEq(token.balanceOf(_who(1)), 99e6 + 1);
        assertEq(e.account(_who(1)).premiumPaid, 0);
        vm.expectRevert(CollateralVault.BadUnits.selector);
        e.claimTrader(_who(1));
        _assertFullyExited();
    }

    function testHaltPreventsNewAllocationsActivationAndRollover() public {
        _deploy(1, 0);
        _fund(_who(1), 100e6, false);
        HaltView memory halt = oracle.haltEarly();
        _assertStoppedEpoch(L0, halt);
        _assertTerminalMutationsRejected();
        assertTrue(oracle.finalize(2));
        _prepareClaims();
        assertEq(e.claimTrader(_who(1)), 100e6);
        _assertTerminalMutationsRejected();
        _assertFullyExited();
    }

    function testInactiveRolloverCannotCreateAnEpoch() public {
        _deploy(1, 0);
        _fund(_who(1), 100e6, false);
        vm.expectRevert(RiskStorage.BadState.selector);
        e.beginRollover();
        assertFalse(e.active());
        assertFalse(e.halted());
        (uint64 epochId,,,,,,) = e.epoch();
        assertEq(epochId, 0);
        _assertInvariants();
    }

    function testScheduledHaltTimeRejectsAllocationsBeforeMaterialization() public {
        _deploy(1, 0);
        address depositor = _who(1);
        token.mint(depositor, 2e6);
        vm.startPrank(depositor);
        token.approve(address(vault), 2e6);
        vault.deposit(2e6);
        vm.stopPrank();
        vm.warp(T);
        vm.startPrank(depositor);
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        vault.allocate(address(e), 1e6, false);
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        vault.allocate(address(e), 1e6, true);
        assertEq(vault.freeAtoms(depositor), 2e6);
        vault.withdraw(2e6);
        vm.stopPrank();
        assertEq(token.balanceOf(depositor), 2e6);
        assertEq(e.participantCount(), 0);
        assertEq(e.reserveVault().totalShares(), 0);
        vm.prank(GOV);
        vm.expectRevert();
        e.activateMarket();
        assertFalse(e.active());
        assertFalse(e.halted());
    }

    function _assertTerminalMutationsRejected() private {
        vm.prank(GOV);
        vm.expectRevert();
        e.activateMarket();
        vm.expectRevert(RiskStorage.BadState.selector);
        e.beginRollover();
        address depositor = _who(2);
        token.mint(depositor, 2e6);
        vm.startPrank(depositor);
        token.approve(address(vault), 2e6);
        vault.deposit(2e6);
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        vault.allocate(address(e), 1e6, false);
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        vault.allocate(address(e), 1e6, true);
        assertEq(vault.freeAtoms(depositor), 2e6);
        vault.withdraw(2e6);
        vm.stopPrank();
        assertFalse(e.active());
        assertTrue(e.halted());
        assertEq(e.participantCount(), 1);
        assertEq(e.reserveVault().totalShares(), 0);
    }

    function _prepareClaims() private {
        assertTrue(e.prepareSnapshotChunk(32).done);
        assertFalse(e.preparePayoutChunk(32).done);
        assertTrue(e.preparePayoutChunk(32).done);
        assertTrue(e.finishPreparation());
        assertTrue(e.claimsEnabled());
        assertFalse(e.recoveryRequired());
    }

    function _assertStoppedEpoch(uint64 expectedCutoff, HaltView memory halt) private view {
        assertTrue(halt.halted);
        assertFalse(e.active());
        assertEq(halt.economicHaltAt, expectedCutoff);
        assertEq(halt.accrualCutoff, expectedCutoff);
        assertEq(halt.accrualCutoff, e.accrualCutoff());
        assertEq(halt.oiHaltLots, 0);
        assertEq(e.fundingFQ(), 0);
        assertEq(e.fundingClearingQ(), 0);
        assertEq(e.fundingBudgetQ(), 0);
        assertEq(e.fundingCushionQ(), 0);
        (uint64 epochId, uint64 start, uint64 end, uint64 last, uint64 stop, int256 rate, bool stopped) =
            e.epoch();
        assertEq(epochId, 0);
        assertEq(start, expectedCutoff);
        assertEq(end, expectedCutoff);
        assertEq(last, expectedCutoff);
        assertEq(stop, expectedCutoff);
        assertEq(rate, 0);
        assertTrue(stopped);
    }

    function _assertFullyExited() private view {
        assertEq(e.allocationQ(), 0);
        assertEq(vault.marketAtoms(address(e)), 0);
        assertEq(vault.recognizedAtoms(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(e.outstandingReserveAtoms(), 0);
        assertEq(e.unpaidTraderClaims(), 0);
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
        assertFalse(e.active());
        assertTrue(e.halted());
    }
}
