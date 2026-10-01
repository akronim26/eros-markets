// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

contract A030Test is AccountingTestBase {
    function testCannotBackdateHaltBeforePostedFunding() public {
        _trade();
        _roll(1e12, P.Tariff(0, 0, 0));
        vm.warp(block.timestamp + 10);
        h.sync(alice);
        vm.expectRevert();
        h.freeze(uint64(block.timestamp - 1));
        assertFalse(h.halted());
        h.freeze(uint64(block.timestamp));
        h.snapshotPage(32);
        assertTrue(h.snapshotComplete());
    }

    function testHaltDuringRolloverDoesNotDoubleAccrueVisitedAccount() public {
        _trade();
        _roll(1e12, P.Tariff(1e14, 1e14, 1e18));
        vm.warp(_epochEnd());
        h.beginRoll();
        h.rollPage(1);
        int256 visited = h.account(alice).value.cashQ;
        vm.warp(block.timestamp + 123);
        h.freeze(uint64(block.timestamp));
        assertLt(h.accrualCutoff(), h.economicHaltAt());
        h.snapshotPage(1);
        h.snapshotPage(1);
        (int128 n, int256 c) = h.frozen(alice);
        assertEq(n, 1000000);
        assertEq(c, visited);
        assertEq(h.fundingClearingQ(), 0);
    }
}
