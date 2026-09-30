// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

contract BookBitmapTest is Test {
    BookHarness book;
    uint256 constant M = 1;

    function setUp() public {
        book = new BookHarness();
        book.createMarket(M);
    }

    function _best() internal view returns (uint16 bid, uint16 ask) {
        return book.bestBidAsk(M);
    }

    function test_InitSetsSentinelsAndNullSlot() public view {
        for (uint256 w; w < 4; ++w) {
            assertEq(book.bitWord(M, true, w), 1 << 255);
            assertEq(book.bitWord(M, false, w), 1 << 255);
        }
        assertEq(book.orderSlots(M), 1);
    }

    function test_EmptyBookHasNoBestPrices() public view {
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 0);
    }

    function test_RevertWhen_MarketCreatedTwice() public {
        vm.expectRevert(Book.MarketExists.selector);
        book.createMarket(M);
    }

    function test_RevertWhen_MarketUnknown() public {
        vm.expectRevert(Book.NoMarket.selector);
        book.bestBidAsk(2);
    }

    function test_BoundaryTicksMapToExpectedWordAndBit() public {
        uint16[8] memory ticks = [uint16(1), 250, 251, 500, 501, 750, 751, 999];
        for (uint256 i; i < ticks.length; ++i) {
            uint16 k = ticks[i];
            book.setBit(M, true, k);
            uint256 w = (k - 1) / 250;
            assertEq(book.bitWord(M, true, w), (1 << 255) | (1 << ((k - 1) % 250)), "word");
            (uint16 bid,) = _best();
            assertEq(bid, k, "bid");
            book.clearBit(M, true, k);
            assertEq(book.bitWord(M, true, w), 1 << 255, "cleared");
        }
    }

    function test_BestBidIsHighestAndBestAskIsLowest() public {
        book.setBit(M, true, 1);
        book.setBit(M, true, 251);
        book.setBit(M, true, 499);
        book.setBit(M, false, 999);
        book.setBit(M, false, 750);
        book.setBit(M, false, 501);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 499);
        assertEq(ask, 501);
    }

    function test_ExtremeTicks() public {
        book.setBit(M, true, 999);
        book.setBit(M, false, 1);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 999);
        assertEq(ask, 1);
    }

    function test_SentinelNeverReturnedAfterClear() public {
        book.setBit(M, false, 250);
        book.clearBit(M, false, 250);
        book.setBit(M, true, 751);
        book.clearBit(M, true, 751);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 0);
        assertEq(book.bitWord(M, false, 0), 1 << 255);
    }

    function test_SidesAreIndependent() public {
        book.setBit(M, true, 400);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 400);
        assertEq(ask, 0);
    }

    /// Best prices must match a full linear scan for any set of occupied ticks.
    function testFuzz_BestPricesMatchFullScan(uint16[12] memory raw, bool[12] memory isBuy) public {
        bool[1000] memory bids;
        bool[1000] memory asks;
        for (uint256 i; i < raw.length; ++i) {
            uint16 k = uint16(bound(raw[i], 1, 999));
            book.setBit(M, isBuy[i], k);
            if (isBuy[i]) bids[k] = true;
            else asks[k] = true;
        }
        uint16 refBid;
        uint16 refAsk;
        for (uint16 k = 1; k <= 999; ++k) {
            if (bids[k]) refBid = k;
            if (asks[k] && refAsk == 0) refAsk = k;
        }
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, refBid);
        assertEq(ask, refAsk);
        for (uint256 w; w < 4; ++w) {
            assertTrue(book.bitWord(M, true, w) & (1 << 255) != 0);
            assertTrue(book.bitWord(M, false, w) & (1 << 255) != 0);
        }
    }
}
