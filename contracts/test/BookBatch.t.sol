// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {BookHarness} from "./BookHarness.sol";

contract BookBatchTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address mm = makeAddr("mm"); // trader 1
    address taker = makeAddr("taker"); // trader 2

    IBookRiskHooks.OrderKind constant LIMIT = IBookRiskHooks.OrderKind.LIMIT;
    IBookRiskHooks.OrderKind constant IOC = IBookRiskHooks.OrderKind.IOC;
    IBookRiskHooks.OrderKind constant POST = IBookRiskHooks.OrderKind.POST_ONLY;

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
    }

    function _p(IBookRiskHooks.OrderKind kind, bool isBuy, uint16 tick, uint64 size)
        internal
        pure
        returns (Book.Place memory)
    {
        return Book.Place(kind, isBuy, false, tick, size, 8);
    }

    function _batch(address who, uint32[] memory cancels, Book.Place[] memory places)
        internal
        returns (uint32[] memory)
    {
        vm.prank(who);
        return book.batch(cancels, places);
    }

    function _quote(uint16 bid, uint16 ask, uint64 size) internal returns (uint32[] memory) {
        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = _p(POST, true, bid, size);
        ps[1] = _p(POST, false, ask, size);
        return _batch(mm, new uint32[](0), ps);
    }

    function _ids(uint32 a, uint32 b) internal pure returns (uint32[] memory x) {
        x = new uint32[](2);
        (x[0], x[1]) = (a, b);
    }

    function _size(uint32 id) internal view returns (uint64) {
        return book.getOrder(id).size;
    }

    function test_InitialQuoteRestsBothSides() public {
        uint32[] memory ids = _quote(499, 501, 100);
        assertEq(ids.length, 2);
        assertEq(_size(ids[0]), 100);
        assertEq(_size(ids[1]), 100);
        (uint16 bid, uint16 ask) = book.bestBidAsk();
        assertEq(bid, 499);
        assertEq(ask, 501);
        assertEq(book.traderId(mm), 1);
    }

    function test_RequoteCancelsThenPlaces() public {
        uint32[] memory old = _quote(499, 501, 100);
        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = _p(POST, true, 500, 50);
        ps[1] = _p(POST, false, 502, 50);
        uint32[] memory ids = _batch(mm, old, ps);

        assertEq(_size(old[0]), 0);
        assertEq(_size(old[1]), 0);
        assertEq(_size(ids[0]), 50);
        assertEq(_size(ids[1]), 50);
        (uint16 bid, uint16 ask) = book.bestBidAsk();
        assertEq(bid, 500);
        assertEq(ask, 502);
        assertEq(book.reserved(1, true), 50);
        assertEq(book.reserved(1, false), 50);
        assertEq(book.orderSlots(), 3, "requote reuses the freed slots");
    }

    /// Cancels run before places: moving the bid up to the old ask only works in that order.
    function test_CancelsRunBeforePlaces() public {
        uint32[] memory old = _quote(499, 501, 100);
        Book.Place[] memory ps = new Book.Place[](1);
        ps[0] = _p(POST, true, 501, 10);
        uint32[] memory ids = _batch(mm, old, ps);
        assertEq(_size(ids[0]), 10);
    }

    /// A taker fills the maker's ask between the maker's read and its requote (D055).
    function test_StaleCancelAfterFillDoesNotRevertRequote() public {
        uint32[] memory old = _quote(499, 501, 100);
        vm.prank(taker);
        book.placeOrder(_p(IOC, true, 501, 100));
        assertEq(_size(old[1]), 0, "ask filled");

        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = _p(POST, true, 500, 100);
        ps[1] = _p(POST, false, 502, 100);
        uint32[] memory ids = _batch(mm, old, ps);
        assertEq(_size(old[0]), 0);
        assertEq(_size(ids[0]), 100);
        assertEq(_size(ids[1]), 100);
    }

    function test_DuplicateCancelInBatchIsIdempotent() public {
        uint32[] memory old = _quote(499, 501, 100);
        uint32[] memory cancels = new uint32[](3);
        (cancels[0], cancels[1], cancels[2]) = (old[0], old[0], 0);
        _batch(mm, cancels, new Book.Place[](0));
        assertEq(_size(old[0]), 0);
        assertEq(_size(old[1]), 100);
    }

    /// A stale id whose slot now belongs to someone else's live order is simply skipped.
    function test_StaleCancelOfReusedSlotIsSkipped() public {
        uint32[] memory old = _quote(499, 501, 100);
        _batch(mm, _ids(old[0], old[1]), new Book.Place[](0));
        vm.prank(taker);
        uint32 theirs = book.placeOrder(_p(POST, true, 400, 7));
        assertEq(theirs & 0xFFFFFF, old[1] & 0xFFFFFF, "slot reused");

        _batch(mm, old, new Book.Place[](0));
        assertEq(_size(theirs), 7);
    }

    function test_RevertWhen_BatchCancelsSomeoneElsesLiveOrder() public {
        vm.prank(taker);
        uint32 theirs = book.placeOrder(_p(POST, true, 400, 7));
        uint32[] memory cancels = new uint32[](1);
        cancels[0] = theirs;
        vm.expectRevert(Book.NotOwner.selector);
        _batch(mm, cancels, new Book.Place[](0));
    }

    function test_CrossingPostOnlyIsSkippedWithIdZero() public {
        vm.prank(taker);
        book.placeOrder(_p(POST, false, 501, 10));
        Book.Place[] memory ps = new Book.Place[](3);
        ps[0] = _p(POST, true, 499, 10);
        ps[1] = _p(POST, true, 501, 10); // crosses the taker's ask
        ps[2] = _p(POST, false, 503, 10);
        uint32[] memory ids = _batch(mm, new uint32[](0), ps);

        assertTrue(ids[0] != 0);
        assertEq(ids[1], 0);
        assertTrue(ids[2] != 0);
        assertEq(book.position(book.traderId(mm)), 0, "skipped order never traded");
    }

    function test_BatchCanTakeLiquidity() public {
        vm.prank(taker);
        book.placeOrder(_p(POST, false, 501, 10));
        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = _p(IOC, true, 501, 4);
        ps[1] = _p(LIMIT, true, 501, 10);
        uint32[] memory ids = _batch(mm, new uint32[](0), ps);

        assertEq(ids[0], 0);
        assertEq(_size(ids[1]), 4, "6 filled, 4 rest");
        assertEq(book.position(book.traderId(mm)), 10);
    }

    function test_RevertWhen_BatchHasBadOrder() public {
        uint32[] memory old = _quote(499, 501, 100);
        Book.Place[] memory ps = new Book.Place[](1);
        ps[0] = _p(POST, true, 0, 10);
        vm.expectRevert(Book.BadTick.selector);
        _batch(mm, old, ps);
        assertEq(_size(old[0]), 100, "whole batch reverted");
    }

    function test_EmptyBatchRegistersTrader() public {
        uint32[] memory ids = _batch(mm, new uint32[](0), new Book.Place[](0));
        assertEq(ids.length, 0);
        assertEq(book.traderId(mm), 1);
    }

    function test_RevertWhen_BatchBeforeBookOpened() public {
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.NoMarket.selector);
        fresh.batch(new uint32[](0), new Book.Place[](0));
    }
}
