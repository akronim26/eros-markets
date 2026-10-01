// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, AccountingHarness, P} from "./AccountingTestBase.sol";

contract A022Test is AccountingTestBase {
    function testBaselineFundingCannotBeEnabledAfterListing() public {
        AccountingHarness baseline = new AccountingHarness(vault, decision, treasury, end, false, false);
        vault.registerEngine(address(baseline));
        vm.expectRevert();
        baseline.activate(1, P.Tariff(0, 0, 0));
        assertFalse(baseline.fundingFeatureEnabled());
    }

    function testOldOiBudgetAndStaleStop() public {
        _trade();
        _roll(1e12, P.Tariff(0, 0, 0));
        uint64 start = uint64(block.timestamp);
        h.setContext(start + 10, 6e17, true);
        vm.warp(start + 20);
        h.sync(alice);
        assertEq(h.fundingFQ(), 10e12);
        assertEq(h.fundingCushionQ(), 0);
        h.setContext(start + 100, 6e17, true);
        vm.warp(start + 30);
        h.sync(bob);
        assertEq(h.fundingFQ(), 10e12);
        assertEq(h.fundingClearingQ(), 0);
        _assertLedger();
    }
}
