// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

/// @notice Drives random place / take / cancel / requote / churn traffic into one market. Ticks
///         stay in a narrow band so orders cross often, and churn pushes slots through their
///         generations up to retirement.
contract BookHandler is Test {
    BookHarness public book;
    uint32 public constant TRADERS = 4;
    address[4] actors;

    mapping(uint32 => bool) public issued;
    bool public reissued;
    uint32[] public ids;
    uint256 public retirements;

    constructor(BookHarness _book) {
        book = _book;
        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            vm.prank(actors[i]);
            book.batch(new uint32[](0), new Book.Place[](0)); // registers ids 1..4
        }
    }

    function _record(uint32 id) internal {
        if (id == 0) return;
        if (issued[id]) reissued = true;
        issued[id] = true;
        ids.push(id);
    }

    function _place(uint256 seed) internal pure returns (Book.Place memory p) {
        p.kind = Book.OrderType(seed % 3);
        p.isBuy = (seed >> 8) % 2 == 0;
        p.reduceOnly = (seed >> 16) % 8 == 0;
        p.tick = uint16(495 + (seed >> 24) % 11);
        p.size = uint64(1 + (seed >> 40) % 50);
        p.maxFills = uint8((seed >> 56) % 9);
    }

    function place(uint256 actorSeed, uint256 seed) external {
        Book.Place[] memory ps = new Book.Place[](1);
        ps[0] = _place(seed);
        // Through batch so a crossing post-only order is skipped instead of reverting.
        vm.prank(actors[actorSeed % 4]);
        uint32[] memory out = book.batch(new uint32[](0), ps);
        _record(out[0]);
    }

    function take(uint256 actorSeed, uint256 seed) external {
        Book.Place memory p = _place(seed);
        if (p.kind == Book.OrderType.POST_ONLY) p.kind = Book.OrderType.IOC;
        vm.prank(actors[actorSeed % 4]);
        _record(book.placeOrder(p));
    }

    function cancel(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint32 id = ids[idSeed % ids.length];
        Book.Order memory o = book.getOrder(id);
        if (o.owner == 0) {
            // Dead id: only a batch may cancel it, and it must do nothing.
            uint32[] memory c = new uint32[](1);
            c[0] = id;
            vm.prank(actors[idSeed % 4]);
            book.batch(c, new Book.Place[](0));
            return;
        }
        vm.prank(actors[o.owner - 1]);
        book.cancel(id);
    }

    function requote(uint256 actorSeed, uint256 seedA, uint256 seedB) external {
        uint256 a = actorSeed % 4;
        uint32[] memory c = new uint32[](ids.length < 6 ? ids.length : 6);
        for (uint256 i; i < c.length; ++i) {
            uint32 id = ids[ids.length - 1 - i];
            uint32 owner = book.getOrder(id).owner;
            // Stale ids stay in (they must be no-ops); other traders' live ids are dropped.
            c[i] = (owner == 0 || owner == a + 1) ? id : 0;
        }
        Book.Place[] memory ps = new Book.Place[](2);
        ps[0] = _place(seedA);
        ps[1] = _place(seedB);
        vm.prank(actors[a]);
        uint32[] memory out = book.batch(c, ps);
        _record(out[0]);
        _record(out[1]);
    }

    /// Place and cancel far from the touch many times to age slot generations.
    function churn(uint256 actorSeed, uint8 rounds) external {
        address who = actors[actorSeed % 4];
        for (uint256 i; i < uint256(rounds) % 64; ++i) {
            vm.prank(who);
            uint32 id = book.placeOrder(Book.Place(Book.OrderType.POST_ONLY, true, false, 10, 1, 0));
            _record(id);
            if (id >> 24 == 255) ++retirements;
            vm.prank(who);
            book.cancel(id);
        }
    }

    function setFailing(uint256 actorSeed, bool fail) external {
        book.setFailMaker(uint32(actorSeed % 4) + 1, fail);
    }
}

contract BookInvariantTest is Test {
    BookHarness book;
    BookHandler handler;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests

    function setUp() public {
        book = new BookHarness();
        book.createMarket(MAX_FILLS);
        handler = new BookHandler(book);
        targetContract(address(handler));
    }

    /// INV-8: bit set iff level non-empty, level size = sum of its orders, links agree, every
    /// live order linked exactly once, free list complete, reservations match, bid < ask.
    function invariant_BookStructure() public view {
        book.checkInvariants(handler.TRADERS());
    }

    /// Every fill moves the same units between two traders.
    function invariant_PositionsNetToZero() public view {
        int256 sum;
        for (uint32 t = 1; t <= 4; ++t) {
            sum += book.position(t);
        }
        assertEq(sum, 0);
    }

    /// A public order id is never issued twice, across slot reuse and retirement.
    function invariant_IdsNeverReissued() public view {
        assertFalse(handler.reissued());
    }
}
