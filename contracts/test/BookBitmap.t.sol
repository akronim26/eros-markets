// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

contract BookBitmapTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
    }

    function _best() internal view returns (uint16 bid, uint16 ask) {
        return book.bestBidAsk();
    }

    function test_InitSetsSentinelsAndNullSlot() public view {
        for (uint256 w; w < 4; ++w) {
            assertEq(book.bitWord(true, w), 1 << 255);
            assertEq(book.bitWord(false, w), 1 << 255);
        }
        assertEq(book.orderSlots(), 1);
    }

    function test_EmptyBookHasNoBestPrices() public view {
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 0);
    }

    function test_RevertWhen_MarketCreatedTwice() public {
        vm.expectRevert(Book.MarketExists.selector);
        book.createMarket(MAX_FILLS);
    }

    function test_RevertWhen_BookNotOpened() public {
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.NoMarket.selector);
        fresh.bestBidAsk();
    }

    function test_BoundaryTicksMapToExpectedWordAndBit() public {
        uint16[8] memory ticks = [uint16(1), 250, 251, 500, 501, 750, 751, 999];
        for (uint256 i; i < ticks.length; ++i) {
            uint16 k = ticks[i];
            book.setBit(true, k);
            uint256 w = (k - 1) / 250;
            assertEq(book.bitWord(true, w), (1 << 255) | (1 << ((k - 1) % 250)), "word");
            (uint16 bid,) = _best();
            assertEq(bid, k, "bid");
            book.clearBit(true, k);
            assertEq(book.bitWord(true, w), 1 << 255, "cleared");
        }
    }

    function test_BestBidIsHighestAndBestAskIsLowest() public {
        book.setBit(true, 1);
        book.setBit(true, 251);
        book.setBit(true, 499);
        book.setBit(false, 999);
        book.setBit(false, 750);
        book.setBit(false, 501);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 499);
        assertEq(ask, 501);
    }

    function test_ExtremeTicks() public {
        book.setBit(true, 999);
        book.setBit(false, 1);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 999);
        assertEq(ask, 1);
    }

    function test_SentinelNeverReturnedAfterClear() public {
        book.setBit(false, 250);
        book.clearBit(false, 250);
        book.setBit(true, 751);
        book.clearBit(true, 751);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 0);
        assertEq(book.bitWord(false, 0), 1 << 255);
    }

    function test_SidesAreIndependent() public {
        book.setBit(true, 400);
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
            book.setBit(isBuy[i], k);
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
            assertTrue(book.bitWord(true, w) & (1 << 255) != 0);
            assertTrue(book.bitWord(false, w) & (1 << 255) != 0);
        }
    }
}
