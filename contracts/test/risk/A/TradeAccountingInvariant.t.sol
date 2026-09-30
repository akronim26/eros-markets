// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, C} from "./AccountingTestBase.sol";

abstract contract TradeAccountingChecks is AccountingTestBase {
    function testFuzzPairedAndFees(uint32 size) public {
        uint64 n = uint64(uint256(size) % 1000000 + 1);
        h.trade(alice, bob, n, 600, 3, 7);
        _assertLedger();
        h.trade(bob, alice, n, 600, 0, 0);
        _assertLedger();
        assertEq(h.account(alice).value.lots, 0);
    }

    function testStaleUnrestCannotReleaseNewEpoch() public {
        C.Orders memory o = C.Orders(7, 2800e18, 0, 0, 0);
        uint64 old = h.account(alice).orderEpoch;
        h.setOrders(alice, o, old);
        h.cancelOrders(alice);
        C.Orders memory next = C.Orders(11, 6600e18, 0, 0, 0);
        h.setOrders(alice, next, h.account(alice).orderEpoch);
        C.Orders memory zero;
        h.releaseOld(alice, h.marketOrderEpoch(), old, zero);
        assertEq(h.account(alice).orders.bidValueQ, 6600e18);
        _assertLedger();
    }
}
