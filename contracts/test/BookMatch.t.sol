// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {BookHarness} from "./BookHarness.sol";

contract BookMatchTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address alice = makeAddr("alice"); // trader 1
    address bob = makeAddr("bob"); // trader 2
    address carol = makeAddr("carol"); // trader 3
    address taker = makeAddr("taker"); // trader 4

    IBookRiskHooks.OrderKind constant LIMIT = IBookRiskHooks.OrderKind.LIMIT;
    IBookRiskHooks.OrderKind constant IOC = IBookRiskHooks.OrderKind.IOC;
    IBookRiskHooks.OrderKind constant POST = IBookRiskHooks.OrderKind.POST_ONLY;

    struct F {
        uint32 makerOrder;
        uint32 maker;
        uint32 taker;
        uint16 tick;
        uint64 size;
    }

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
        // Register traders in a fixed order so their ids are 1..4.
        address[4] memory who = [alice, bob, carol, taker];
        for (uint256 i; i < 4; ++i) {
            uint32 id = _post(who[i], true, 1, 1);
            vm.prank(who[i]);
            book.cancel(id);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _p(IBookRiskHooks.OrderKind kind, bool isBuy, uint16 tick, uint64 size, bool ro, uint8 maxFills)
        internal
        pure
        returns (Book.Place memory)
    {
        return Book.Place(kind, isBuy, ro, tick, size, maxFills);
    }

    function _place(address who, Book.Place memory p) internal returns (uint32) {
        vm.prank(who);
        return book.placeOrder(p);
    }

    function _post(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        return _place(who, _p(POST, isBuy, tick, size, false, 0));
    }

    function _take(bool isBuy, uint16 limit, uint64 size, uint8 maxFills) internal returns (uint32) {
        return _place(taker, _p(IOC, isBuy, limit, size, false, maxFills));
    }

    function _fills() internal view returns (F[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Book.Fill.selector) ++n;
        }
        out = new F[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Book.Fill.selector) continue;
            (uint32 maker, uint32 tk, uint16 tick, uint64 size,,) =
                abi.decode(logs[i].data, (uint32, uint32, uint16, uint64, uint256, uint256));
            out[n++] = F(uint32(uint256(logs[i].topics[1])), maker, tk, tick, size);
        }
    }

    function _best() internal view returns (uint16 bid, uint16 ask) {
        return book.bestBidAsk();
    }

    function _size(uint32 id) internal view returns (uint64) {
        return book.getOrder(id).size;
    }

    // ------------------------------------------------------------------ basic fills

    function test_TakerFillsSingleMakerExactly() public {
        uint32 a = _post(alice, false, 502, 300);
        vm.expectEmit(address(book));
        emit Book.Fill(a, 1, 4, 502, 300, 0, 0);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 300, false, 8));

        assertEq(id, 0, "nothing rests");
        assertEq(_size(a), 0);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 0);
        assertEq(book.position(1), -300);
        assertEq(book.position(4), 300);
        assertEq(book.reserved(1, false), 0);
        assertEq(book.getLevel(false, 502).size, 0);
    }

    function test_PartialMakerFillStaysAtHead() public {
        uint32 a = _post(alice, false, 502, 300);
        uint32 b = _post(bob, false, 502, 100);
        _take(true, 502, 120, 8);

        assertEq(_size(a), 180);
        assertEq(book.getLevel(false, 502).head, a & 0xFFFFFF);
        assertEq(book.getLevel(false, 502).size, 280);
        assertEq(_size(b), 100);
        assertEq(book.reserved(1, false), 180);
    }

    function test_SameTickFillsOldestFirst() public {
        uint32 a = _post(alice, false, 502, 300);
        uint32 b = _post(bob, false, 502, 100);
        uint32 c = _post(carol, false, 502, 500);
        vm.recordLogs();
        _take(true, 502, 350, 8);
        F[] memory f = _fills();

        assertEq(f.length, 2);
        assertEq(f[0].makerOrder, a);
        assertEq(f[0].size, 300);
        assertEq(f[1].makerOrder, b);
        assertEq(f[1].size, 50);
        assertEq(_size(b), 50);
        assertEq(_size(c), 500);
        assertEq(book.getLevel(false, 502).head, b & 0xFFFFFF);
    }

    function test_BetterPriceFillsFirstAtMakerPrice() public {
        _post(alice, false, 505, 10);
        _post(bob, false, 501, 10);
        _post(carol, false, 503, 10);
        vm.recordLogs();
        _take(true, 999, 30, 8);
        F[] memory f = _fills();

        assertEq(f.length, 3);
        assertEq(f[0].tick, 501);
        assertEq(f[0].maker, 2);
        assertEq(f[1].tick, 503);
        assertEq(f[2].tick, 505);
    }

    function test_SellSweepsBidsHighestFirst() public {
        _post(alice, true, 499, 10);
        _post(bob, true, 500, 10);
        _post(carol, true, 300, 10);
        vm.recordLogs();
        _take(false, 499, 100, 8);
        F[] memory f = _fills();

        assertEq(f.length, 2);
        assertEq(f[0].tick, 500);
        assertEq(f[1].tick, 499);
        (uint16 bid,) = _best();
        assertEq(bid, 300);
        assertEq(book.position(4), -20);
    }

    function test_ExtremeTicksTrade() public {
        uint32 a = _post(alice, false, 1, 5);
        vm.expectEmit(address(book));
        emit Book.Fill(a, 1, 4, 1, 5, 0, 0);
        _take(true, 999, 5, 8);
        _post(bob, true, 999, 5);
        _take(false, 1, 5, 8);
        assertEq(book.position(4), 0);
        assertEq(book.position(2), 5);
    }

    function test_LimitStopsAtPrice() public {
        _post(alice, false, 501, 10);
        _post(alice, false, 502, 10);
        uint32 id = _place(taker, _p(LIMIT, true, 501, 25, false, 8));

        assertEq(_size(id), 15, "remainder rests at the limit");
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 501);
        assertEq(ask, 502);
        assertEq(book.reserved(4, true), 15);
    }

    function test_NonCrossingLimitRestsWithoutFill() public {
        _post(alice, false, 510, 10);
        uint256 finished = book.takerDoneCalls();
        vm.recordLogs();
        uint32 id = _place(taker, _p(LIMIT, true, 509, 5, false, 8));
        assertEq(_fills().length, 0);
        assertEq(_size(id), 5);
        assertEq(book.takerDoneCalls(), finished + 1);
    }

    /// Every admitted order, post-only included, holds one taker permit that is finished once.
    function test_FinishCalledOncePerOrder() public {
        uint256 finished = book.takerDoneCalls();
        _post(alice, false, 510, 10);
        assertEq(book.takerDoneCalls(), finished + 1);
        _take(true, 510, 3, 8);
        assertEq(book.takerDoneCalls(), finished + 2);
    }

    // ------------------------------------------------------------------ order types

    function test_IocDropsRemainder() public {
        _post(alice, false, 502, 10);
        uint32 id = _take(true, 502, 50, 8);
        assertEq(id, 0);
        (uint16 bid,) = _best();
        assertEq(bid, 0);
        assertEq(book.position(4), 10);
        assertEq(book.reserved(4, true), 0);
    }

    function test_IocWithNoLiquidityDoesNothing() public {
        uint32 id = _take(true, 502, 50, 8);
        assertEq(id, 0);
        assertEq(book.position(4), 0);
    }

    function test_PostOnlyRestsWhenNotCrossing() public {
        _post(alice, false, 502, 10);
        uint32 id = _post(bob, true, 501, 7);
        assertEq(_size(id), 7);
    }

    function test_RevertWhen_PostOnlyCrosses() public {
        _post(alice, false, 502, 10);
        vm.expectRevert(Book.PostOnlyCrosses.selector);
        _post(bob, true, 502, 1);
        vm.expectRevert(Book.PostOnlyCrosses.selector);
        _post(bob, true, 600, 1);
    }

    function test_RevertWhen_PostOnlySellCrossesBid() public {
        _post(alice, true, 400, 10);
        vm.expectRevert(Book.PostOnlyCrosses.selector);
        _post(bob, false, 400, 1);
    }

    function test_RevertWhen_PostOnlyCrossesOwnOrder() public {
        _post(alice, false, 502, 10);
        vm.expectRevert(Book.PostOnlyCrosses.selector);
        _post(alice, true, 502, 1);
    }

    // ------------------------------------------------------------------ input validation

    function test_RevertWhen_BadInputs() public {
        vm.startPrank(taker);
        vm.expectRevert(Book.BadTick.selector);
        book.placeOrder(_p(LIMIT, true, 0, 1, false, 8));
        vm.expectRevert(Book.BadTick.selector);
        book.placeOrder(_p(LIMIT, true, 1000, 1, false, 8));
        vm.expectRevert(Book.BadSize.selector);
        book.placeOrder(_p(LIMIT, true, 500, 0, false, 8));
        vm.expectRevert(Book.BadMaxFills.selector);
        book.placeOrder(_p(LIMIT, true, 500, 1, false, 65));
        vm.expectRevert(Book.BadTick.selector);
        book.placeOrder(_p(POST, true, 1000, 1, false, 0));
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.NoMarket.selector);
        fresh.placeOrder(_p(LIMIT, true, 500, 1, false, 8));
        vm.stopPrank();
    }

    function test_MaxFillsAtProtocolBound() public {
        for (uint256 i; i < 64; ++i) {
            _post(alice, false, 500, 1);
        }
        _take(true, 500, 64, 64);
        assertEq(book.position(4), 64);
        (, uint16 ask) = _best();
        assertEq(ask, 0);
    }

    // ------------------------------------------------------------------ self-trade and failed makers

    function test_SelfTradeCancelsRestingOrderAndContinues() public {
        uint32 own = _post(taker, false, 502, 10);
        uint32 a = _post(alice, false, 502, 10);
        vm.expectEmit(address(book));
        emit Book.OrderCancelled(own, 10, Book.CancelReason.SELF_TRADE);
        vm.expectEmit(address(book));
        emit Book.Fill(a, 1, 4, 502, 10, 0, 0);
        _take(true, 502, 10, 8);

        assertEq(_size(own), 0);
        assertEq(book.position(4), 10);
        assertEq(book.reserved(4, false), 0);
    }

    function test_FailedMakerIsCancelledAndSkipped() public {
        uint32 a = _post(alice, false, 502, 10);
        uint32 b = _post(bob, false, 502, 10);
        book.setFailMaker(1, true);
        vm.expectEmit(address(book));
        emit Book.OrderCancelled(a, 10, Book.CancelReason.FAILED_CHECK);
        _take(true, 502, 10, 8);

        assertEq(_size(a), 0);
        assertEq(_size(b), 0);
        assertEq(book.position(1), 0);
        assertEq(book.position(2), -10);
        assertEq(book.reserved(1, false), 0);
    }

    function test_MaxFillsCountsFills() public {
        _post(alice, false, 500, 1);
        _post(bob, false, 500, 1);
        _post(carol, false, 501, 1);
        _take(true, 999, 3, 2);
        assertEq(book.position(4), 2);
        (, uint16 ask) = _best();
        assertEq(ask, 501);
    }

    function test_MaxFillsCountsFailedAndSelfTradeSteps() public {
        book.setFailMaker(1, true);
        _post(alice, false, 500, 1);
        _post(taker, false, 500, 1);
        _post(alice, false, 500, 1);
        uint32 good = _post(bob, false, 500, 1);
        _take(true, 500, 1, 3);

        assertEq(book.position(4), 0, "budget spent on 3 bad orders");
        assertEq(_size(good), 1);
        assertEq(book.getLevel(false, 500).head, good & 0xFFFFFF);
    }

    function test_ZeroMaxFillsNeverMatches() public {
        _post(alice, false, 500, 1);
        uint32 id = _place(taker, _p(LIMIT, true, 500, 1, false, 0));
        assertEq(id, 0, "crossing remainder dropped");
        assertEq(book.position(4), 0);
        id = _place(taker, _p(LIMIT, true, 499, 1, false, 0));
        assertEq(_size(id), 1, "non-crossing order still rests");
    }

    // ------------------------------------------------------------------ crossed remainder

    function test_CrossedRemainderIsDroppedWhenBudgetRunsOut() public {
        _post(alice, false, 501, 1);
        _post(bob, false, 501, 1);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 10, false, 1));

        assertEq(id, 0);
        assertEq(book.position(4), 1);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 0);
        assertEq(ask, 501);
    }

    function test_CrossedSellRemainderIsDropped() public {
        _post(alice, true, 499, 1);
        _post(bob, true, 498, 1);
        uint32 id = _place(taker, _p(LIMIT, false, 498, 10, false, 1));
        assertEq(id, 0);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 498);
        assertEq(ask, 0);
    }

    function test_RemainderRestsOnceBookNoLongerCrosses() public {
        _post(alice, false, 501, 1);
        _post(bob, false, 503, 1);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 10, false, 1));
        assertEq(_size(id), 9);
        (uint16 bid, uint16 ask) = _best();
        assertEq(bid, 502);
        assertEq(ask, 503);
    }

    // ------------------------------------------------------------------ reduce-only

    function test_ReduceOnlyMakerIsClippedAndRestCancelled() public {
        book.setPosition(1, 100);
        uint32 a = _place(alice, _p(POST, false, 502, 100, true, 0));
        book.setPosition(1, 40); // alice's position shrinks to 40 after the order rests
        uint32 b = _post(bob, false, 502, 100);
        vm.recordLogs();
        _take(true, 502, 70, 8);
        F[] memory f = _fills();

        assertEq(f.length, 2);
        assertEq(f[0].makerOrder, a);
        assertEq(f[0].size, 40);
        assertEq(f[1].makerOrder, b);
        assertEq(f[1].size, 30);
        assertEq(_size(a), 0, "clipped remainder cancelled");
        assertEq(book.position(1), 0);
        assertEq(book.reserved(1, false), 0);
        assertEq(book.getLevel(false, 502).size, 70);
    }

    function test_ReduceOnlyMakerClipEmitsClipped() public {
        book.setPosition(1, 100);
        uint32 a = _place(alice, _p(POST, false, 502, 100, true, 0));
        book.setPosition(1, 40);
        vm.expectEmit(address(book));
        emit Book.OrderCancelled(a, 60, Book.CancelReason.CLIPPED);
        _take(true, 502, 70, 8);
    }

    function test_ReduceOnlyMakerWithNothingToReduceIsCancelled() public {
        book.setPosition(1, 100);
        uint32 a = _place(alice, _p(POST, false, 502, 100, true, 0));
        book.setPosition(1, 0); // flat by the time a taker reaches the order
        _take(true, 502, 10, 8);
        assertEq(_size(a), 0);
        assertEq(book.position(1), 0);
        assertEq(book.position(4), 0);
        assertEq(book.reserved(1, false), 0, "pruned maker released once");
    }

    function test_ReduceOnlyMakerExactReductionStaysLive() public {
        book.setPosition(1, 100);
        uint32 a = _place(alice, _p(POST, false, 502, 100, true, 0));
        _take(true, 502, 60, 8);
        assertEq(_size(a), 40, "fill < size but == request: not clipped");
    }

    function test_ReduceOnlyTakerIsClippedToPosition() public {
        book.setPosition(4, -30); // taker short 30
        _post(alice, false, 502, 100);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 100, true, 8));
        assertEq(id, 0, "clipped size fully filled, nothing rests");
        assertEq(book.position(4), 0);
        assertEq(book.position(1), -30);
    }

    function test_ReduceOnlyTakerRemainderRestsReduceOnly() public {
        book.setPosition(4, -30);
        _post(alice, false, 502, 10);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 100, true, 8));
        Book.Order memory o = book.getOrder(id);
        assertEq(o.size, 20);
        assertEq(o.flags, book.FLAG_BUY() | book.FLAG_REDUCE_ONLY() | book.FLAG_LIVE());
    }

    function test_ReduceOnlyTakerWithoutPositionDoesNothing() public {
        _post(alice, false, 502, 100);
        uint32 id = _place(taker, _p(LIMIT, true, 502, 100, true, 8));
        assertEq(id, 0);
        assertEq(book.position(4), 0);
        assertEq(book.getLevel(false, 502).size, 100);
    }

    // ------------------------------------------------------------------ atomicity

    function test_RejectedTakerRevertsEveryFill() public {
        uint32 a = _post(alice, false, 502, 10);
        book.setFailMaker(2, true);
        uint32 b = _post(bob, false, 502, 10);
        book.setRejectTaker(true);
        vm.expectRevert(BookHarness.TakerRejected.selector);
        _take(true, 502, 20, 8);

        assertEq(_size(a), 10);
        assertEq(_size(b), 10, "failed-maker cancel rolled back too");
        assertEq(book.position(1), 0);
    }

    // ------------------------------------------------------------------ ids in fills

    function test_FillCarriesRecycledOrderId() public {
        uint32 a = _post(alice, false, 502, 1);
        vm.prank(alice);
        book.cancel(a);
        uint32 a2 = _post(alice, false, 502, 1);
        assertEq(a2 & 0xFFFFFF, a & 0xFFFFFF);
        assertEq(a2 >> 24, (a >> 24) + 1);
        vm.expectEmit(address(book));
        emit Book.Fill(a2, 1, 4, 502, 1, 0, 0);
        _take(true, 502, 1, 8);
    }

    // ------------------------------------------------------------------ fuzz

    /// Whatever the book holds, a buyer never trades above its limit or beyond its size, fills
    /// come in non-decreasing price order, and at most maxFills of them happen.
    function testFuzz_TakerRespectsLimitSizeAndBudget(
        uint16[8] memory ticks,
        uint64[8] memory sizes,
        uint16 limit,
        uint64 want,
        uint8 maxFills
    ) public {
        limit = uint16(bound(limit, 1, 999));
        want = uint64(bound(want, 1, 1e6));
        maxFills = uint8(bound(maxFills, 0, 64));
        address[3] memory makers = [alice, bob, carol];
        for (uint256 i; i < 8; ++i) {
            _post(makers[i % 3], false, uint16(bound(ticks[i], 1, 999)), uint64(bound(sizes[i], 1, 1e5)));
        }
        vm.recordLogs();
        _take(true, limit, want, maxFills);
        F[] memory f = _fills();
        uint256 total;
        uint16 last;
        for (uint256 i; i < f.length; ++i) {
            assertLe(f[i].tick, limit);
            assertGe(f[i].tick, last);
            last = f[i].tick;
            total += f[i].size;
        }
        assertLe(f.length, maxFills);
        assertLe(total, want);
        assertEq(int256(total), book.position(4));
        (uint16 bid, uint16 ask) = _best();
        assertTrue(bid == 0 || ask == 0 || bid < ask);
    }
}
