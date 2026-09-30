// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A016Test is AccountingTestBase {
    function testRegistryBoundAndNoReuse() public {
        for (uint256 i = 2; i < 1024; i++) {
            h.registerOnly(address(uint160(100000 + i)));
        }
        assertEq(h.participantCount(), 1024);
        vm.expectRevert();
        h.registerOnly(address(90000));
        h.registerOnly(alice);
        assertEq(h.participantCount(), 1024);
    }
}
