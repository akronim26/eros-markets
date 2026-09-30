// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

/// @notice The integration surface other modules build on: the risk snapshot and taker totals in
///         Ctx (R2), admission gates (R4 stages), protocol cancels (R3) and touch depth (pricing).
contract BookSeamTest is Test {
    BookHarness book;
    uint256 constant M = 1;
    address maker = makeAddr("maker"); // trader 1
    address taker = makeAddr("taker"); // trader 2

    function setUp() public {
        book = new BookHarness();
        book.createMarket(M);
        vm.prank(maker);
        book.batch(M, new uint32[](0), new Book.Place[](0));
        vm.prank(taker);
        book.batch(M, new uint32[](0), new Book.Place[](0));
    }

    function _post(address who, bool isBuy, uint16 tick, uint96 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(M, Book.Place(Book.OrderType.POST_ONLY, isBuy, false, tick, size, 0));
    }

    function _ioc(address who, bool isBuy, uint16 tick, uint96 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(M, Book.Place(Book.OrderType.IOC, isBuy, false, tick, size, 8));
    }

    // ------------------------------------------------------------------ risk snapshot and totals

    function test_SnapshotLoadedAtStartReachesEveryHook() public {
        _post(maker, false, 501, 10);
        book.setSnapshotMark(777);
        _ioc(taker, true, 501, 10);
        assertEq(book.makerSawMark(), 777);
        assertEq(book.takerFillSawMark(), 777);
        assertEq(book.doneSawMark(), 777);
    }

    function test_TakerDoneSeesFilledAndCost() public {
        _post(maker, false, 501, 10);
        _post(maker, false, 503, 5);
        _ioc(taker, true, 503, 12);
        assertEq(book.doneFilled(), 12);
        assertEq(book.doneCost(), 10 * 501 + 2 * 503);
    }

    function test_TakerDoneSeesZeroTotalsWithoutFills() public {
        _post(maker, false, 501, 10);
        _ioc(taker, true, 500, 12);
        assertEq(book.doneFilled(), 0);
        assertEq(book.doneCost(), 0);
    }

    function test_SellerTotalsUseMakerPrices() public {
        _post(maker, true, 600, 3);
        _post(maker, true, 590, 3);
        _ioc(taker, false, 1, 5);
        assertEq(book.doneFilled(), 5);
        assertEq(book.doneCost(), 3 * 600 + 2 * 590);
    }

    function test_FailedMakersDoNotCountInTotals() public {
        _post(maker, false, 501, 10);
        book.setFailMaker(1, true);
        _ioc(taker, true, 501, 10);
        assertEq(book.doneFilled(), 0);
        assertEq(book.doneCost(), 0);
    }

    // ------------------------------------------------------------------ admission (stages)

    function _all(bool ro) internal pure returns (Book.Place[3] memory ps) {
        ps[0] = Book.Place(Book.OrderType.LIMIT, true, ro, 500, 5, 8);
        ps[1] = Book.Place(Book.OrderType.IOC, true, ro, 500, 5, 8);
        ps[2] = Book.Place(Book.OrderType.POST_ONLY, true, ro, 400, 5, 0);
    }

    function test_HaltedMarketRejectsEveryOrderType() public {
        _post(maker, false, 500, 10);
        book.setStage(M, BookHarness.Stage.Halted);
        Book.Place[3] memory ps = _all(true);
        for (uint256 i; i < 3; ++i) {
            vm.prank(taker);
            vm.expectRevert(BookHarness.MarketHalted.selector);
            book.placeOrder(M, ps[i]);
        }
        Book.Place[] memory one = new Book.Place[](1);
        one[0] = ps[2];
        vm.prank(taker);
        vm.expectRevert(BookHarness.MarketHalted.selector);
        book.batch(M, new uint32[](0), one);
        assertEq(book.position(M, 2), 0);
    }

    function test_CancelsStillWorkWhenHalted() public {
        uint32 a = _post(maker, false, 500, 10);
        uint32 b = _post(maker, false, 501, 10);
        book.setStage(M, BookHarness.Stage.Halted);
        vm.prank(maker);
        book.cancel(M, a);
        uint32[] memory c = new uint32[](1);
        c[0] = b;
        vm.prank(maker);
        book.batch(M, c, new Book.Place[](0));
        assertEq(book.getOrder(M, a).size, 0);
        assertEq(book.getOrder(M, b).size, 0);
        assertEq(book.reserved(M, 1, false), 0);
    }

    function test_ReduceOnlyStageAdmitsOnlyReduceOnlyOrders() public {
        book.setStage(M, BookHarness.Stage.ReduceOnly);
        Book.Place[3] memory plain = _all(false);
        for (uint256 i; i < 3; ++i) {
            vm.prank(taker);
            vm.expectRevert(BookHarness.ReduceOnlyStage.selector);
            book.placeOrder(M, plain[i]);
        }
        book.setPosition(M, 2, -5); // taker short 5
        vm.prank(taker);
        uint32 id = book.placeOrder(M, _all(true)[2]);
        assertEq(book.getOrder(M, id).size, 5);
        assertEq(book.lastRestFlags(), book.FLAG_BUY() | book.FLAG_REDUCE_ONLY());
    }

    function test_MinSizeGate() public {
        book.setMinSize(250);
        vm.prank(taker);
        vm.expectRevert(BookHarness.BelowMinSize.selector);
        book.placeOrder(M, Book.Place(Book.OrderType.POST_ONLY, true, false, 400, 249, 0));
        vm.prank(taker);
        book.placeOrder(M, Book.Place(Book.OrderType.POST_ONLY, true, false, 400, 250, 0));
    }

    function test_RestAndUnrestHooksGetFlagsWithoutLiveBit() public {
        uint32 id = _post(maker, false, 500, 10);
        assertEq(book.lastRestFlags(), 0);
        vm.prank(maker);
        book.cancel(M, id);
        assertEq(book.lastUnrestFlags(), 0);
        _post(maker, true, 400, 10);
        _ioc(taker, false, 400, 4);
        assertEq(book.lastUnrestFlags(), book.FLAG_BUY(), "maker fill passes the maker's flags");
    }
}
