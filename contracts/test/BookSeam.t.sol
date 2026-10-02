// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

/// @notice The integration surface other modules build on: the risk snapshot and taker totals in
///         Ctx (R2), admission gates (R4 stages) and touch depth (pricing).
contract BookSeamTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address maker = makeAddr("maker"); // trader 1
    address taker = makeAddr("taker"); // trader 2

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
        vm.prank(maker);
        book.batch(new uint32[](0), new Book.Place[](0));
        vm.prank(taker);
        book.batch(new uint32[](0), new Book.Place[](0));
    }

    function _post(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(Book.Place(Book.OrderType.POST_ONLY, isBuy, false, tick, size, 0));
    }

    function _ioc(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(Book.Place(Book.OrderType.IOC, isBuy, false, tick, size, 8));
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
        book.setStage(BookHarness.Stage.Halted);
        Book.Place[3] memory ps = _all(true);
        for (uint256 i; i < 3; ++i) {
            vm.prank(taker);
            vm.expectRevert(BookHarness.MarketHalted.selector);
            book.placeOrder(ps[i]);
        }
        Book.Place[] memory one = new Book.Place[](1);
        one[0] = ps[2];
        vm.prank(taker);
        vm.expectRevert(BookHarness.MarketHalted.selector);
        book.batch(new uint32[](0), one);
        assertEq(book.position(2), 0);
    }

    function test_CancelsStillWorkWhenHalted() public {
        uint32 a = _post(maker, false, 500, 10);
        uint32 b = _post(maker, false, 501, 10);
        book.setStage(BookHarness.Stage.Halted);
        vm.prank(maker);
        book.cancel(a);
        uint32[] memory c = new uint32[](1);
        c[0] = b;
        vm.prank(maker);
        book.batch(c, new Book.Place[](0));
        assertEq(book.getOrder(a).size, 0);
        assertEq(book.getOrder(b).size, 0);
        assertEq(book.reserved(1, false), 0);
    }

    function test_ReduceOnlyStageAdmitsOnlyReduceOnlyOrders() public {
        book.setStage(BookHarness.Stage.ReduceOnly);
        Book.Place[3] memory plain = _all(false);
        for (uint256 i; i < 3; ++i) {
            vm.prank(taker);
            vm.expectRevert(BookHarness.ReduceOnlyStage.selector);
            book.placeOrder(plain[i]);
        }
        book.setPosition(2, -5); // taker short 5
        vm.prank(taker);
        uint32 id = book.placeOrder(_all(true)[2]);
        assertEq(book.getOrder(id).size, 5);
        assertEq(book.lastRestFlags(), book.FLAG_BUY() | book.FLAG_REDUCE_ONLY());
    }

    function test_MinSizeGate() public {
        book.setMinSize(250);
        vm.prank(taker);
        vm.expectRevert(BookHarness.BelowMinSize.selector);
        book.placeOrder(Book.Place(Book.OrderType.POST_ONLY, true, false, 400, 249, 0));
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.POST_ONLY, true, false, 400, 250, 0));
    }

    function test_RestAndUnrestHooksGetFlagsWithoutLiveBit() public {
        uint32 id = _post(maker, false, 500, 10);
        assertEq(book.lastRestFlags(), 0);
        vm.prank(maker);
        book.cancel(id);
        assertEq(book.lastUnrestFlags(), 0);
        _post(maker, true, 400, 10);
        _ioc(taker, false, 400, 4);
        assertEq(book.lastUnrestFlags(), book.FLAG_BUY(), "maker fill passes the maker's flags");
    }

    // ------------------------------------------------------------------ maxFills

    function test_MaxFillsIsSetAtCreation() public {
        BookHarness fresh = new BookHarness();
        vm.expectEmit(address(fresh));
        emit Book.MaxFillsSet(3);
        fresh.createMarket(3);
        assertEq(fresh.maxFills(), 3);
        assertEq(book.maxFills(), MAX_FILLS, "other book untouched");
    }

    function test_OrdersAboveTheBoundAreRejected() public {
        BookHarness fresh = new BookHarness();
        fresh.createMarket(3);
        vm.startPrank(taker);
        fresh.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 500, 1, 3));
        vm.expectRevert(Book.BadMaxFills.selector);
        fresh.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 500, 1, 4));
        vm.stopPrank();
    }

    function test_MaxFillsCanBeRetuned() public {
        book.setMaxFills(2);
        vm.prank(taker);
        vm.expectRevert(Book.BadMaxFills.selector);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 500, 1, 3));

        vm.expectEmit(address(book));
        emit Book.MaxFillsSet(255);
        book.setMaxFills(255);
        vm.prank(taker);
        book.placeOrder(Book.Place(Book.OrderType.IOC, true, false, 500, 1, 255));
    }

    function test_RevertWhen_MaxFillsZero() public {
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.BadMaxFills.selector);
        fresh.createMarket(0);
        vm.expectRevert(Book.BadMaxFills.selector);
        book.setMaxFills(0);
    }

    function test_RevertWhen_MaxFillsBeforeBookOpened() public {
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.NoMarket.selector);
        fresh.setMaxFills(5);
        vm.expectRevert(Book.NoMarket.selector);
        fresh.maxFills();
    }

    // ------------------------------------------------------------------ touch depth

    function test_TouchReportsBestLevelsAndSizes() public {
        (uint16 bid, uint96 bidSize, uint16 ask, uint96 askSize) = book.touch();
        assertEq(bid, 0);
        assertEq(bidSize, 0);
        assertEq(ask, 0);
        assertEq(askSize, 0);

        _post(maker, true, 498, 100);
        _post(maker, true, 499, 30);
        _post(taker, true, 499, 20);
        _post(maker, false, 502, 7);
        _post(maker, false, 505, 900);
        (bid, bidSize, ask, askSize) = book.touch();
        assertEq(bid, 499);
        assertEq(bidSize, 50);
        assertEq(ask, 502);
        assertEq(askSize, 7);
    }

    function test_TouchFollowsFillsAndEmptyLevels() public {
        _post(maker, false, 502, 7);
        _post(maker, false, 505, 900);
        _ioc(taker, true, 505, 10);
        (,, uint16 ask, uint96 askSize) = book.touch();
        assertEq(ask, 505);
        assertEq(askSize, 897);
    }
}
