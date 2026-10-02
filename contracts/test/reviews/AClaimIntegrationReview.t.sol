pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {ClearingPhase} from "../../src/math/RiskTypes.sol";
import {ConversionGate} from "../../src/settlement/ConversionGate.sol";
import {ReserveVault} from "../../src/vaults/ReserveVault.sol";

contract AClaimIntegrationReviewTest is CombinedBase {
    function _prepareClaims(bool withTraders) internal {
        _deploy(1, 100_000);
        if (withTraders) {
            _fund(_who(1), 120e6, false);
            _fund(_who(2), 100e6, false);
        }
        _activate();
        oracle.haltEarly();
        oracle.finalize(2);
        while (!e.prepareSnapshotChunk(1).done) {}
        while (!e.preparePayoutChunk(1).done) {}
        assertTrue(e.finishPreparation());
    }

    function testDirectVaultAndEngineClaimsShareCounterAndCashFence() public {
        _prepareClaims(true);
        assertEq(e.unpaidTraderClaims(), 2);
        assertFalse(e.anyCashClaim());
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.UNSELECTED));
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.READY));
        vault.claim(address(e), _who(1));
        assertTrue(e.traderClaimed(_who(1)));
        assertEq(e.unpaidTraderClaims(), 1);
        assertTrue(e.anyCashClaim());
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.CASH));
        e.claimTrader(_who(2));
        assertEq(e.unpaidTraderClaims(), 0);
        assertTrue(e.allTraderClaimsPaid());
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
        assertEq(token.balanceOf(_who(1)), 120e6);
        assertEq(token.balanceOf(_who(2)), 100e6);
        vm.expectRevert();
        vault.claim(address(e), _who(1));
        assertEq(e.unpaidTraderClaims(), 0);
    }

    function testBlockedTransferRollsBackCounterAndClaimMode() public {
        _prepareClaims(true);
        token.configure(_who(1), false);
        vm.expectRevert();
        vault.claim(address(e), _who(1));
        assertEq(e.unpaidTraderClaims(), 2);
        assertFalse(e.anyCashClaim());
        assertFalse(e.traderClaimed(_who(1)));
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.UNSELECTED));
        assertEq(e.claimableAtoms(_who(1)), 120e6);
        e.claimTrader(_who(2));
        assertEq(e.unpaidTraderClaims(), 1);
        token.configure(address(0), false);
        e.claimTrader(_who(1));
        assertTrue(e.allTraderClaimsPaid());
    }

    function testOnlyVaultCanRecordClaims() public {
        _prepareClaims(true);
        vm.expectRevert();
        e.onCashClaim(_who(1), 120e6);
        assertEq(e.unpaidTraderClaims(), 2);
        assertFalse(e.anyCashClaim());
    }

    function testReserveClaimDoesNotConsumeTraderCounter() public {
        _prepareClaims(true);
        ReserveVault reserveVault = e.reserveVault();
        vm.prank(LP);
        reserveVault.notice();
        vm.warp(block.timestamp + 7 days);
        e.redeemReserve(LP);
        vault.claim(address(e), LP);
        assertEq(e.unpaidTraderClaims(), 2);
        assertFalse(e.traderClaimed(LP));
        assertTrue(e.anyCashClaim());
        assertEq(token.balanceOf(LP), 100_000e6);
    }

    function testNoPayableTraderEntitlementsIsComplete() public {
        _prepareClaims(false);
        assertEq(e.unpaidTraderClaims(), 0);
        assertTrue(e.allTraderClaimsPaid());
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
    }

    function testTraderAndReserveClaimsForSameOwnerInEitherOrder() public {
        for (uint256 order; order < 2; ++order) {
            _deploy(1, 100_000);
            _fund(LP, 7e6, false);
            _activate();
            oracle.haltEarly();
            oracle.finalize(2);
            while (!e.prepareSnapshotChunk(1).done) {}
            while (!e.preparePayoutChunk(1).done) {}
            e.finishPreparation();
            assertEq(e.unpaidTraderClaims(), 1);
            ReserveVault reserveVault = e.reserveVault();
            vm.prank(LP);
            reserveVault.notice();
            vm.warp(block.timestamp + 7 days);
            if (order == 0) {
                e.claimTrader(LP);
                assertEq(e.unpaidTraderClaims(), 0);
            }
            e.redeemReserve(LP);
            vault.claim(address(e), LP);
            assertEq(e.unpaidTraderClaims(), 0);
            assertTrue(e.allTraderClaimsPaid());
            assertEq(token.balanceOf(LP), 100_007e6);
        }
    }

    function testClaimReentrancyRevertsEveryAccountingEffect() public {
        _prepareClaims(true);
        token.setCallback(address(vault), abi.encodeCall(vault.claim, (address(e), _who(2))));
        vm.expectRevert();
        e.claimTrader(_who(1));
        assertEq(e.unpaidTraderClaims(), 2);
        assertEq(e.claimableAtoms(_who(1)), 120e6);
        assertEq(e.claimableAtoms(_who(2)), 100e6);
        assertFalse(e.anyCashClaim());
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.UNSELECTED));
        token.setCallback(address(0), "");
        e.claimTrader(_who(1));
        e.claimTrader(_who(2));
        assertTrue(e.allTraderClaimsPaid());
    }
}
