pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {BookHarness} from "./BookHarness.sol";

contract BookBatchBoundsTest is Test {
    BookHarness internal book;
    address internal constant MAKER = address(0x1001);
    address internal constant TAKER = address(0x1002);
    bytes4 internal constant ACTION_LIMIT = bytes4(keccak256("BatchActionLimit()"));
    bytes4 internal constant STEP_LIMIT = bytes4(keccak256("BatchStepLimit()"));

    function setUp() public {
        book = new BookHarness();
        book.createMarket(64);
    }

    function _request(IBookRiskHooks.OrderKind kind, uint8 steps) internal pure returns (Book.Place memory) {
        return Book.Place(kind, true, false, 500, 10, steps, 0);
    }

    function testTooManyPlacesRejectedBeforeRegistration() public {
        Book.Place[] memory places = new Book.Place[](33);
        for (uint256 index; index < places.length; ++index) {
            places[index] = _request(IBookRiskHooks.OrderKind.POST_ONLY, 0);
        }
        vm.prank(TAKER);
        vm.expectRevert(ACTION_LIMIT);
        book.batch(new uint32[](0), places);
        assertEq(book.traderCount(), 0);
    }

    function testOversizedCancelBatchDoesNotCancelAnyOrder() public {
        vm.prank(MAKER);
        uint32 orderId = book.placeOrder(_request(IBookRiskHooks.OrderKind.POST_ONLY, 0));
        uint32[] memory cancels = new uint32[](33);
        cancels[0] = orderId;
        vm.prank(MAKER);
        vm.expectRevert(ACTION_LIMIT);
        book.batch(cancels, new Book.Place[](0));
        assertEq(book.getOrder(orderId).size, 10);
    }

    function testMixedBatchCountsCancellationsAndPlacesTogether() public {
        Book.Place[] memory places = new Book.Place[](1);
        places[0] = _request(IBookRiskHooks.OrderKind.POST_ONLY, 0);
        vm.prank(TAKER);
        vm.expectRevert(ACTION_LIMIT);
        book.batch(new uint32[](32), places);
        assertEq(book.traderCount(), 0);
    }

    function testAggregateRequestedStepsCannotExceedMarketCap() public {
        Book.Place[] memory places = new Book.Place[](2);
        places[0] = _request(IBookRiskHooks.OrderKind.IOC, 32);
        places[1] = _request(IBookRiskHooks.OrderKind.LIMIT, 33);
        vm.prank(TAKER);
        vm.expectRevert(STEP_LIMIT);
        book.batch(new uint32[](0), places);
        assertEq(book.traderCount(), 0);
    }

    function testExactActionBoundAcceptsPostOnlyWithoutChargingTraversalBudget() public {
        Book.Place[] memory places = new Book.Place[](32);
        for (uint256 index; index < places.length; ++index) {
            places[index] = _request(IBookRiskHooks.OrderKind.POST_ONLY, 64);
        }
        vm.prank(TAKER);
        uint32[] memory orderIds = book.batch(new uint32[](0), places);
        assertEq(orderIds.length, 32);
        assertEq(book.reserved(book.traderId(TAKER), true), 320);
        for (uint256 index; index < orderIds.length; ++index) {
            assertGt(orderIds[index], 0);
        }
    }

    function testExactAggregateStepBoundStillMatchesBothOrders() public {
        vm.prank(MAKER);
        book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, false, false, 500, 20, 0, 0));
        Book.Place[] memory places = new Book.Place[](2);
        places[0] = _request(IBookRiskHooks.OrderKind.IOC, 32);
        places[1] = _request(IBookRiskHooks.OrderKind.IOC, 32);
        vm.prank(TAKER);
        book.batch(new uint32[](0), places);
        assertEq(book.position(book.traderId(TAKER)), 20);
        assertEq(book.position(book.traderId(MAKER)), -20);
    }

    function testSmallerMarketCapAlsoBoundsBatchActions() public {
        book.setMaxFills(8);
        vm.prank(TAKER);
        vm.expectRevert(ACTION_LIMIT);
        book.batch(new uint32[](9), new Book.Place[](0));
        assertEq(book.traderCount(), 0);
    }
}
