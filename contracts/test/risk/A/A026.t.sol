// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A026Test is AccountingTestBase {
    function testPostconditionFailureRevertsPriorSyncAndBothLegs() public {
        _trade();
        int256 cash = h.account(alice).value.cashQ;
        uint256 oi = h.oiAllLots();
        vm.expectRevert();
        h.trade(alice, bob, 1_000_000_000, 600, 3, 7);
        assertEq(h.account(alice).value.cashQ, cash);
        assertEq(h.oiAllLots(), oi);
        assertEq(h.protocolFeeQ(), 0);
        _assertLedger();
    }
}
