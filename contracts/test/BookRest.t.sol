// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness, TraderIds} from "./BookHarness.sol";

contract BookRestTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
    }

    function _rest(address who, bool isBuy, uint16 tick, uint64 size) internal returns (uint32) {
        vm.prank(who);
        return book.rest(isBuy, tick, size);
    }

    function _cancel(address who, uint32 id) internal {
        vm.prank(who);
        book.cancel(id);
    }

    function _level(bool isBuy, uint16 tick) internal view returns (Book.Level memory) {
        return book.getLevel(isBuy, tick);
    }

    // ------------------------------------------------------------------ rest

    function test_FirstOrderRests() public {
        vm.expectEmit(address(book));
        emit TraderIds.TraderRegistered(alice, 1);
        vm.expectEmit(address(book));
        emit Book.OrderPlaced(1, 1, 502, 300, 0, 0);
        uint32 id = _rest(alice, false, 502, 300);

        assertEq(id, 1);
        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, 1);
        assertEq(lv.tail, 1);
        assertEq(lv.size, 300);
        assertTrue(lv.used);
        Book.Order memory o = book.getOrder(id);
        assertEq(o.owner, 1);
        assertEq(o.size, 300);
        assertEq(o.tick, 502);
        assertEq(o.flags, book.FLAG_LIVE());
        assertEq(o.gen, 0);
        assertEq(o.prev, 0);
        assertEq(o.next, 0);
        (, uint16 ask) = book.bestBidAsk();
        assertEq(ask, 502);
        assertEq(book.reserved(1, false), 300);
    }

    function test_BuyOrderCarriesBuyFlag() public {
        uint32 id = _rest(alice, true, 400, 10);
        assertEq(book.getOrder(id).flags, book.FLAG_BUY() | book.FLAG_LIVE());
        (uint16 bid,) = book.bestBidAsk();
        assertEq(bid, 400);
        assertEq(book.reserved(1, true), 10);
    }

    /// The spec's example level: tick 502, orders of 300, 100 and 500 in time order.
    function test_FifoLinksAndLevelSize() public {
        uint32 a = _rest(alice, false, 502, 300);
        uint32 b = _rest(bob, false, 502, 100);
        uint32 c = _rest(alice, false, 502, 500);

        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, a);
        assertEq(lv.tail, c);
        assertEq(lv.size, 900);
        assertEq(book.getOrder(a).next, b);
        assertEq(book.getOrder(b).prev, a);
        assertEq(book.getOrder(b).next, c);
        assertEq(book.getOrder(c).prev, b);
        assertEq(book.getOrder(c).next, 0);
    }

    function test_TradersGetDistinctIds() public {
        _rest(alice, false, 600, 1);
        _rest(bob, false, 600, 1);
        _rest(alice, false, 600, 1);
        assertEq(book.traderId(alice), 1);
        assertEq(book.traderId(bob), 2);
        assertEq(book.traderCount(), 2);
    }

    // ------------------------------------------------------------------ cancel

    function test_CancelOnlyOrderEmptiesLevel() public {
        uint32 id = _rest(alice, false, 502, 300);
        vm.expectEmit(address(book));
        emit Book.OrderCancelled(id, 300, Book.CancelReason.USER);
        _cancel(alice, id);

        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, 0);
        assertEq(lv.tail, 0);
        assertEq(lv.size, 0);
        assertTrue(lv.used, "level slot stays non-zero");
        (, uint16 ask) = book.bestBidAsk();
        assertEq(ask, 0);
        assertEq(book.bitWord(false, 2), 1 << 255);
        assertEq(book.reserved(1, false), 0);
        assertEq(book.getOrder(id).owner, 0, "dead id reads as empty");
    }

    function test_CancelHead() public {
        uint32 a = _rest(alice, false, 502, 300);
        uint32 b = _rest(alice, false, 502, 100);
        uint32 c = _rest(alice, false, 502, 500);
        _cancel(alice, a);
        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, b);
        assertEq(lv.tail, c);
        assertEq(lv.size, 600);
        assertEq(book.getOrder(b).prev, 0);
    }

    function test_CancelMiddle() public {
        uint32 a = _rest(alice, false, 502, 300);
        uint32 b = _rest(alice, false, 502, 100);
        uint32 c = _rest(alice, false, 502, 500);
        _cancel(alice, b);
        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, a);
        assertEq(lv.tail, c);
        assertEq(lv.size, 800);
        assertEq(book.getOrder(a).next, c);
        assertEq(book.getOrder(c).prev, a);
    }

    function test_CancelTail() public {
        uint32 a = _rest(alice, false, 502, 300);
        uint32 b = _rest(alice, false, 502, 100);
        uint32 c = _rest(alice, false, 502, 500);
        _cancel(alice, c);
        Book.Level memory lv = _level(false, 502);
        assertEq(lv.head, a);
        assertEq(lv.tail, b);
        assertEq(lv.size, 400);
        assertEq(book.getOrder(b).next, 0);
    }

    function test_CancelKeepsOtherLevelsAndBits() public {
        uint32 a = _rest(alice, false, 502, 1);
        _rest(alice, false, 503, 1);
        _cancel(alice, a);
        (, uint16 ask) = book.bestBidAsk();
        assertEq(ask, 503);
    }

    function test_TombstoneStaysNonZero() public {
        uint32 id = _rest(alice, false, 502, 300);
        _cancel(alice, id);
        Book.Order memory o = book.orderAt(id);
        assertEq(o.owner, 1);
        assertEq(o.tick, 502);
        assertEq(o.size, 0);
        assertEq(o.flags, 0);
    }

    function test_RevertWhen_CancelByNonOwner() public {
        uint32 id = _rest(alice, false, 502, 300);
        _rest(bob, false, 502, 1);
        vm.expectRevert(Book.NotOwner.selector);
        _cancel(bob, id);
    }

    function test_RevertWhen_CancelByUnregistered() public {
        uint32 id = _rest(alice, false, 502, 300);
        vm.expectRevert(Book.NotOwner.selector);
        _cancel(makeAddr("stranger"), id);
    }

    function test_RevertWhen_CancelTwice() public {
        uint32 id = _rest(alice, false, 502, 300);
        _cancel(alice, id);
        vm.expectRevert(Book.NotLive.selector);
        _cancel(alice, id);
    }

    function test_RevertWhen_CancelUnknownIds() public {
        _rest(alice, false, 502, 300);
        vm.expectRevert(Book.NotLive.selector);
        _cancel(alice, 0);
        vm.expectRevert(Book.NotLive.selector);
        _cancel(alice, 2);
        vm.expectRevert(Book.NotLive.selector);
        _cancel(alice, (1 << 24) | 1); // right slot, wrong generation
    }

    function test_RevertWhen_GetLevelBadTick() public {
        vm.expectRevert(Book.BadTick.selector);
        book.getLevel(true, 0);
        vm.expectRevert(Book.BadTick.selector);
        book.getLevel(false, 1000);
        vm.expectRevert(Book.BadTick.selector);
        book.getLevel(false, type(uint16).max);
    }

    function test_RevertWhen_BookNotOpened() public {
        BookHarness fresh = new BookHarness();
        vm.expectRevert(Book.NoMarket.selector);
        fresh.cancel(1);
        vm.expectRevert(Book.NoMarket.selector);
        fresh.getOrder(1);
        vm.expectRevert(Book.NoMarket.selector);
        fresh.getLevel(true, 1);
        vm.expectRevert(Book.NoMarket.selector);
        fresh.rest(true, 1, 1);
    }

    // ------------------------------------------------------------------ slot recycling

    function test_FreedSlotsAreReusedLifoWithNewGeneration() public {
        uint32 a = _rest(alice, false, 502, 1); // slot 1
        uint32 b = _rest(alice, false, 502, 1); // slot 2
        _cancel(alice, a);
        _cancel(alice, b);
        assertEq(book.freeHead(), 2);

        uint32 c = _rest(bob, true, 100, 5);
        assertEq(c, (1 << 24) | 2, "slot 2, gen 1");
        uint32 d = _rest(bob, true, 100, 5);
        assertEq(d, (1 << 24) | 1, "slot 1, gen 1");
        assertEq(book.freeHead(), 0);
        assertEq(book.orderSlots(), 3, "no new slots allocated");

        Book.Order memory o = book.getOrder(c);
        assertEq(o.owner, 2);
        assertEq(o.size, 5);
        assertEq(o.tick, 100);
        assertEq(o.flags, book.FLAG_BUY() | book.FLAG_LIVE());
        assertEq(o.prev, 0);
        assertEq(o.next, d & 0xFFFFFF, "links hold slots; stale free-list link overwritten");
    }

    function test_StaleIdCannotTouchReusedSlot() public {
        uint32 old = _rest(alice, false, 502, 1);
        _cancel(alice, old);
        uint32 fresh = _rest(alice, false, 700, 9);
        assertEq(fresh & 0xFFFFFF, old & 0xFFFFFF, "same slot");
        assertTrue(fresh != old);

        vm.expectRevert(Book.NotLive.selector);
        _cancel(alice, old);
        assertEq(book.getOrder(old).owner, 0);
        assertEq(book.getOrder(fresh).size, 9);
    }

    function test_SlotRetiresAtMaxGeneration() public {
        uint32 id;
        for (uint256 g; g <= 255; ++g) {
            id = _rest(alice, false, 502, 1);
            assertEq(id, uint32(g << 24) | 1);
            _cancel(alice, id);
        }
        // Generation 255 was used once and is now retired, not recycled.
        assertEq(book.freeHead(), 0);
        id = _rest(alice, false, 502, 1);
        assertEq(id, 2, "fresh slot 2");
        assertEq(book.orderSlots(), 3);
    }

    /// Any interleaving of rests and cancels keeps level sizes equal to the live orders on it.
    function testFuzz_RestCancelKeepsLevelSums(uint16[16] memory ticks, uint8 cancelMask) public {
        uint32[16] memory ids;
        uint256 expected;
        for (uint256 i; i < 16; ++i) {
            ids[i] = _rest(alice, false, uint16(bound(ticks[i], 500, 503)), uint64(i + 1));
        }
        for (uint256 i; i < 8; ++i) {
            if (cancelMask & (1 << i) != 0) _cancel(alice, ids[i * 2]);
        }
        for (uint16 k = 500; k <= 503; ++k) {
            Book.Level memory lv = _level(false, k);
            uint256 sum;
            uint256 count;
            for (uint32 s = lv.head; s != 0; s = book.orderAt(s).next) {
                sum += book.orderAt(s).size;
                ++count;
            }
            assertEq(lv.size, sum);
            expected += sum;
            bool bit = book.bitWord(false, (k - 1) / 250) & (1 << ((k - 1) % 250)) != 0;
            assertEq(bit, count != 0);
        }
        assertEq(book.reserved(1, false), expected);
    }
}
