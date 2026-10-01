// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

contract A025Test is AccountingTestBase {
    function testRolloverPausesAndSkippedHoursDoNotAccrue() public {
        _trade();
        vm.warp(_epochEnd());
        h.beginRoll();
        h.rollPage(1);
        vm.expectRevert();
        h.trade(alice, bob, 1, 600, 0, 0);
        vm.expectRevert();
        h.registerOnly(address(123));
        h.rollPage(1);
        h.rollPage(1);
        vm.warp(block.timestamp + 7200);
        h.finishRoll(1e12, P.Tariff(0, 0, 0));
        assertEq(h.fundingFQ(), 0);
        assertEq(h.account(alice).value.cashQ, -480e24);
        _assertLedger();
    }
}
