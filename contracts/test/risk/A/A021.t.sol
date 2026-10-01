// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A021Test is AccountingTestBase {
    function testDecisionPortCannotBeBypassed() public {
        decision.set(alice, false);
        vm.prank(alice);
        vm.expectRevert();
        h.release(1);
        decision.expect(alice, bytes32(uint256(123)));
        decision.set(alice, true);
        vm.prank(alice);
        vm.expectRevert();
        h.release(1);
        _assertLedger();
    }
}
