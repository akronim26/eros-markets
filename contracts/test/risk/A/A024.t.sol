// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

contract A024Test is AccountingTestBase {
    function testTouchExactlyOnceAndClearing() public {
        _trade();
        _roll(-1e12, P.Tariff(1e14, 1e14, 1e18));
        vm.warp(block.timestamp + 60);
        h.sync(bob);
        int256 c = h.account(bob).value.cashQ;
        h.sync(bob);
        assertEq(h.account(bob).value.cashQ, c);
        h.sync(alice);
        assertEq(h.fundingClearingQ(), 0);
        assertEq(h.fundingCushionQ(), 0);
        _assertLedger();
    }
}
