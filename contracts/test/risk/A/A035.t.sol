// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A035Test is AccountingTestBase {
    function testAllOutcomeClaimsPreparedBeforeEnabled() public {
        _trade();
        uint256 snap = vm.snapshotState();
        _finish(0, 1);
        assertEq(h.traderAtoms(alice), 0);
        assertEq(h.traderAtoms(bob), 700e6);
        assertTrue(vm.revertToState(snap));
        snap = vm.snapshotState();
        _finish(1e18, 1);
        assertEq(h.traderAtoms(alice), 520e6);
        assertEq(h.traderAtoms(bob), 0);
        assertTrue(vm.revertToState(snap));
        _finish(5e17, 1);
        assertEq(h.traderAtoms(alice), 20e6);
        assertEq(h.traderAtoms(bob), 200e6);
        assertEq(h.reserveResidualQ(), 100000e24);
    }

    function testFinalPriceAndPartialEscrowDoNotEnableClaims() public {
        _trade();
        h.freeze(uint64(block.timestamp));
        h.finalPrice(5e17, bytes32(uint256(1)));
        vm.expectRevert();
        h.claimTrader(alice);
        h.snapshotPage(32);
        h.scanPayout(32);
        h.allocatePayout(1);
        vm.expectRevert();
        vault.claim(address(h), alice);
        assertFalse(h.claimsEnabled());
    }
}
