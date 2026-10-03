// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {BookHarness} from "./BookHarness.sol";
import {AdmissionMode, RejectCode} from "../src/math/RiskTypes.sol";
import {MathTypes} from "../src/math/MathTypes.sol";

/// @notice The integration surface other modules build on: one risk snapshot per action reaching
///         every hook, fills reported per maker at its price, risk's rejections and stops as
///         codes, a rest and an unrest exactly once per unfilled lot, and touch depth (pricing).
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
        return book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, isBuy, false, tick, size, 0, 0));
    }

    function _ioc(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, isBuy, false, tick, size, 8, 0));
    }

    // ------------------------------------------------------------------ risk snapshot and totals

    function test_SnapshotLoadedAtStartReachesEveryHook() public {
        _post(maker, false, 501, 10);
        book.setSnapshotMark(777);
        _ioc(taker, true, 501, 10);
        assertEq(book.makerSawMark(), 777);
        assertEq(book.doneSawMark(), 777);
    }

    function test_FillsReportLotsAtMakerPrices() public {
        _post(maker, false, 501, 10);
        _post(maker, false, 503, 5);
        _ioc(taker, true, 503, 12);
        assertEq(book.doneFilled(), 12);
        assertEq(book.doneCost(), 10 * 501 + 2 * 503);
    }

    function test_NoFillsReportZeroTotals() public {
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

    /// Risk's record for an order (epochs, reduce version, fee cap) comes back with every later
    /// hook, and a partial fill keeps the fee cap pro rata; an unrest names the tick and epoch.
    function test_OrderKeepsRisksRecord() public {
        vm.prank(maker);
        book.cancelAll(); // account epoch 1
        book.setRestRecord(7, 3, 1000);
        uint32 id = _post(maker, false, 500, 10);
        _ioc(taker, true, 500, 4);
        IBookRiskHooks.OrderView memory v = book.lastMaker();
        assertEq(v.key.slot, id & 0xFFFFFF);
        assertEq(v.owner, 1);
        assertEq(v.tick, 500);
        assertEq(v.remainingLots, 10);
        assertEq(v.admittedAt.marketOrderEpoch, 7);
        assertEq(v.admittedAt.accountOrderEpoch, 1);
        assertEq(v.reduceVersion, 3);
        assertEq(v.remainingFeeCapQ, 1000);
        assertEq(book.getOrder(id).feeCapQ, 600, "6 of 10 lots left");

        vm.prank(maker);
        book.cancel(id);
        BookHarness.Unrest memory u = book.lastUnrest();
        assertEq(u.owner, 1);
        assertEq(u.tag.marketOrderEpoch, 7);
        assertEq(u.tag.accountOrderEpoch, 1);
        assertEq(uint8(u.side), uint8(MathTypes.Side.SELL));
        assertEq(u.tick, 500);
        assertEq(u.lots, 6);
        assertEq(u.feeCapQ, 600);
    }

    /// Cancel-all is one epoch bump: the old orders stay in the book, never fill, are pruned when a
    /// taker reaches them, and removing them later releases nothing a second time.
    function test_CancelAllInvalidatesRestingOrders() public {
        uint32 a = _post(maker, false, 500, 10);
        uint32 b = _post(maker, true, 400, 5);
        vm.expectEmit(address(book));
        emit Book.AllOrdersCancelled(1, 0, 1);
        vm.prank(maker);
        book.cancelAll();
        assertEq(book.reserved(1, false), 0, "released at once");
        assertEq(book.reserved(1, true), 0);
        assertEq(book.getOrder(a).size, 10, "still resting until reached");

        uint32 c = _post(maker, false, 501, 3); // new epoch
        _ioc(taker, true, 501, 20);
        assertEq(book.getOrder(a).size, 0, "pruned when reached");
        assertEq(book.getOrder(c).size, 0);
        assertEq(book.position(2), 3, "only the new order fills");
        vm.prank(maker);
        book.cancel(b);
        assertEq(book.reserved(1, true), 0, "an old order releases nothing");
        book.checkInvariants(2);
    }

    /// Liquidation's entry: the ordinary traversal under FORCED_REDUCTION, reporting the lots
    /// filled and the makers examined; an IOC, so nothing rests.
    function test_ForcedReductionRunsTheOrdinaryTraversal() public {
        book.setPosition(2, 30); // taker long 30
        _post(maker, true, 499, 10);
        _post(maker, true, 498, 10);
        (uint64 filled, uint256 examined) = book.placeForced(
            IBookRiskHooks.OrderRequest(
                2, MathTypes.Side.SELL, IBookRiskHooks.OrderKind.IOC, 498, 30, 0, true, 8
            )
        );
        assertEq(uint8(book.lastMode()), uint8(AdmissionMode.FORCED_REDUCTION));
        assertEq(filled, 20);
        assertEq(examined, 2);
        assertEq(book.position(2), 10);
        (uint16 bid, uint16 ask) = book.bestBidAsk();
        assertEq(bid, 0);
        assertEq(ask, 0, "nothing rests");
    }

    function test_RevertWhen_ForcedReductionAboveTheStepBound() public {
        vm.expectRevert(Book.BadMaxFills.selector);
        book.placeForced(
            IBookRiskHooks.OrderRequest(
                2, MathTypes.Side.SELL, IBookRiskHooks.OrderKind.IOC, 498, 30, 0, true, MAX_FILLS + 1
            )
        );
    }

    // ------------------------------------------------------------------ admission (stages)

    function _all(bool ro) internal pure returns (Book.Place[3] memory ps) {
        ps[0] = Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, ro, 500, 5, 8, 0);
        ps[1] = Book.Place(IBookRiskHooks.OrderKind.IOC, true, ro, 500, 5, 8, 0);
        ps[2] = Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, ro, 400, 5, 0, 0);
    }

    /// Risk rejects with a code, not a revert, so a batch keeps its other actions.
    function test_HaltedMarketRejectsEveryOrderType() public {
        _post(maker, false, 500, 10);
        book.setStage(BookHarness.Stage.Halted);
        Book.Place[3] memory ps = _all(true);
        for (uint256 i; i < 3; ++i) {
            vm.expectEmit(address(book));
            emit Book.OrderRejected(2, RejectCode.HALTED);
            vm.prank(taker);
            assertEq(book.placeOrder(ps[i]), 0);
        }
        Book.Place[] memory one = new Book.Place[](1);
        one[0] = ps[2];
        vm.prank(taker);
        assertEq(book.batch(new uint32[](0), one)[0], 0);
        assertEq(book.position(2), 0);
        assertEq(book.getLevel(false, 500).size, 10, "maker untouched");
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
            vm.expectEmit(address(book));
            emit Book.OrderRejected(2, RejectCode.BAD_STAGE);
            vm.prank(taker);
            assertEq(book.placeOrder(plain[i]), 0);
        }
        book.setPosition(2, -5); // taker short 5
        vm.prank(taker);
        uint32 id = book.placeOrder(_all(true)[2]);
        assertEq(book.getOrder(id).size, 5);
        assertEq(book.lastRestFlags(), book.FLAG_BUY() | book.FLAG_REDUCE_ONLY());
    }

    function test_MinSizeGate() public {
        book.setMinSize(250);
        vm.expectEmit(address(book));
        emit Book.OrderRejected(2, RejectCode.BELOW_MIN_SIZE);
        vm.prank(taker);
        assertEq(
            book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, 400, 249, 0, 0)), 0
        );
        vm.prank(taker);
        assertTrue(
            book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, false, 400, 250, 0, 0)) != 0
        );
    }

    /// A stopped taker keeps the maker; the crossing LIMIT remainder is dropped, never rested.
    function test_StopTakerKeepsTheMaker() public {
        uint32 a = _post(maker, false, 500, 10);
        book.setStopTaker(true);
        vm.prank(taker);
        uint32 id = book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 500, 10, 8, 0));
        assertEq(id, 0);
        assertEq(book.getOrder(a).size, 10);
        assertEq(book.position(2), 0);
        assertEq(book.reserved(2, true), 0);
    }

    /// Filled lots are released inside the fill; only lots that stop resting unfilled are unrested.
    function test_UnrestOnlyForUnfilledLots() public {
        uint32 id = _post(maker, false, 500, 10);
        assertEq(book.lastRestFlags(), 0);
        vm.prank(maker);
        book.cancel(id);
        assertEq(book.unrestCalls(), 1);
        assertEq(book.lastUnrestFlags(), 0);
        _post(maker, true, 400, 10);
        _ioc(taker, false, 400, 4);
        assertEq(book.unrestCalls(), 1, "a fill never unrests");
        assertEq(book.reserved(1, true), 6);
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
        fresh.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 1, 3, 0));
        vm.expectRevert(Book.BadMaxFills.selector);
        fresh.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 1, 4, 0));
        vm.stopPrank();
    }

    function test_MaxFillsCanBeRetuned() public {
        book.setMaxFills(2);
        vm.prank(taker);
        vm.expectRevert(Book.BadMaxFills.selector);
        book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 1, 3, 0));

        vm.expectEmit(address(book));
        emit Book.MaxFillsSet(255);
        book.setMaxFills(255);
        vm.prank(taker);
        book.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 1, 255, 0));
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
