// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

contract A023Test is AccountingTestBase {
    function testNeutralPremiumTouchFrequency() public {
        _trade();
        _roll(1e12, P.Tariff(1e14, 1e14, 1e18));
        uint256 start = block.timestamp;
        uint256 snapshot = vm.snapshotState();
        for (uint256 i = 1; i <= 3; i++) {
            vm.warp(start + i * 600);
            h.sync(alice);
        }
        int256 many = h.account(alice).value.cashQ;
        uint64 expiry = h.account(alice).surchargeUntil;
        assertTrue(vm.revertToState(snapshot));
        vm.warp(start + 1800);
        h.sync(alice);
        assertEq(h.account(alice).value.cashQ, many);
        assertEq(h.account(alice).surchargeUntil, expiry);
        _assertLedger();
    }
}
