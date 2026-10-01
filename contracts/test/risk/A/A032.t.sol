// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";
import {Vm} from "forge-std/Vm.sol";

contract A032Test is AccountingTestBase {
    function testPostingEventHasExactUnitsAndOnePair() public {
        vm.recordLogs();
        _trade();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        bytes32 signature = keccak256("PairedPosting(address,address,uint64,uint16,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == signature) {
                (uint64 lots, uint16 tick, uint256 fees) = abi.decode(logs[i].data, (uint64, uint16, uint256));
                assertEq(lots, 1000000);
                assertEq(tick, 600);
                assertEq(fees, 0);
                count++;
            }
        }
        assertEq(count, 1);
        _assertLedger();
    }
}
