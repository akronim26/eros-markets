// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A034Test is AccountingTestBase {
    function testSnapshotIncludesFlatCashAndRetriesOnce() public {
        _fund(address(1234), 7e6, false);
        _trade();
        h.freeze(uint64(block.timestamp));
        h.snapshotPage(1);
        h.snapshotPage(1);
        assertFalse(h.snapshotComplete());
        h.snapshotPage(1);
        int256 total = h.snapshotCashQ();
        h.snapshotPage(32);
        assertEq(h.snapshotCashQ(), total);
        (int128 n, int256 c) = h.frozen(address(1234));
        assertEq(n, 0);
        assertEq(c, 7e24);
        assertEq(h.fundingClearingQ(), 0);
        assertEq(h.fundingCushionQ(), 0);
    }
}
