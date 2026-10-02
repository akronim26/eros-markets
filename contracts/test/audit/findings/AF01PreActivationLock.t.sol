// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../../integration/CombinedBase.sol";
import {HaltView} from "../../../src/interfaces/IResolutionIngress.sol";
import {ClearingPhase} from "../../../src/math/RiskTypes.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";

/// @notice Regression for audit finding A-F01 (docs/merge/A-audit.md).
contract FindingAF01PreActivationLockTest is CombinedBase {
    function testPreActivationAllocationsCanExitAfterT() public {
        _deploy(1, 1000);
        address trader = _who(1);
        _fund(trader, 100e6, false);
        ReserveVault reserveVault = e.reserveVault();
        vm.prank(LP);
        reserveVault.notice();
        assertFalse(e.active());
        _assertInvariants();

        vm.warp(T + 3 days);
        HaltView memory halt = e.materializeScheduledHalt();
        assertTrue(halt.halted);
        assertEq(halt.economicHaltAt, T);
        assertEq(halt.accrualCutoff, T);
        assertEq(e.accrualCutoff(), halt.accrualCutoff);
        assertEq(halt.oiHaltLots, 0);
        assertEq(halt.frozenAccountCount, 1);
        assertTrue(oracle.finalize(2));
        assertFalse(e.claimsEnabled());
        assertTrue(e.prepareSnapshotChunk(1).done);
        assertFalse(e.preparePayoutChunk(1).done);
        assertTrue(e.preparePayoutChunk(1).done);
        assertTrue(e.finishPreparation());
        assertEq(e.traderAtoms(trader), 100e6);
        assertEq(e.reserveResidualQ(), 1000 * USDC);
        assertEq(e.claimTrader(trader), 100e6);
        assertEq(token.balanceOf(trader), 100e6);
        assertEq(e.redeemReserve(LP), 1000e6);
        assertEq(vault.claim(address(e), LP), 1000e6);
        assertEq(token.balanceOf(LP), 1000e6);
        assertEq(vault.marketAtoms(address(e)), 0);
        assertEq(vault.recognizedAtoms(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(e.allocationQ(), 0);
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
        assertFalse(e.active());
    }
}
