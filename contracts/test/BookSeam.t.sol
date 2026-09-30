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
}
