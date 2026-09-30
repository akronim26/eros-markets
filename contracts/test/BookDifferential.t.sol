// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {BookHarness} from "./BookHarness.sol";

/// @notice Feeds identical random operations to Book and to a naive price-time reference that
///         finds every best order by linear scan, then requires identical fills, remaining sizes,
///         best prices and positions after every operation (spec §9.11 item 5).
contract BookDifferentialTest is Test {
    BookHarness book;
    uint8 constant MAX_FILLS = 64; // test fixture: per-market bound used by these tests
    uint256 constant M = 1;
    uint32 constant FAILING = 3; // this trader's maker fills always fail the Clearing check
    address[4] actors;

    struct RefOrder {
        uint32 id; // the id Book issued for the same order
        uint32 owner;
        bool isBuy;
        bool reduceOnly;
        uint16 tick;
        uint96 size;
    }

    struct Fill {
        uint32 makerOrder;
        uint32 maker;
        uint32 taker;
        uint16 tick;
        uint96 size;
    }

    RefOrder[] ref; // time order = array order; size 0 = dead
    mapping(uint32 => int256) refPos;
    Fill[] refFills;

    function setUp() public {
        book = new BookHarness();
        book.createMarket(M, MAX_FILLS);
        for (uint256 i; i < 4; ++i) {
            actors[i] = makeAddr(string.concat("t", vm.toString(i)));
            vm.prank(actors[i]);
            book.batch(M, new uint32[](0), new Book.Place[](0)); // ids 1..4
        }
        book.setFailMaker(FAILING, true);
    }

    // ------------------------------------------------------------------ reference book

    function _reducible(uint32 t, bool isBuy) internal view returns (uint96) {
        int256 p = refPos[t];
        if (isBuy) return p < 0 ? uint96(uint256(-p)) : 0;
        return p > 0 ? uint96(uint256(p)) : 0;
    }

    function _crossesRef(bool isBuy, uint16 tick) internal view returns (bool) {
        for (uint256 i; i < ref.length; ++i) {
            RefOrder storage o = ref[i];
            if (o.size == 0 || o.isBuy == isBuy) continue;
            if (isBuy ? o.tick <= tick : o.tick >= tick) return true;
        }
        return false;
    }

    /// Index of the best resting order on the side opposite `takerBuys` within `limit`.
    function _bestRef(bool takerBuys, uint16 limit) internal view returns (bool found, uint256 best) {
        for (uint256 i; i < ref.length; ++i) {
            RefOrder storage o = ref[i];
            if (o.size == 0 || o.isBuy == takerBuys) continue;
            if (takerBuys ? o.tick > limit : o.tick < limit) continue;
            if (!found || (takerBuys ? o.tick < ref[best].tick : o.tick > ref[best].tick)) {
                (found, best) = (true, i); // strict comparison keeps the oldest at equal price
            }
        }
    }

    function _refPlace(uint32 taker, Book.Place memory p, bool inBatch)
        internal
        returns (bool rests, uint96 restSize)
    {
        if (p.kind == Book.OrderType.POST_ONLY) {
            if (_crossesRef(p.isBuy, p.tick)) {
                require(inBatch, "standalone crossing post-only not generated");
                return (false, 0);
            }
            return (true, p.size);
        }
        uint96 want = p.size;
        if (p.reduceOnly) {
            uint96 r = _reducible(taker, p.isBuy);
            if (r < want) want = r;
        }
        uint256 steps;
        while (want != 0 && steps < p.maxFills) {
            (bool found, uint256 i) = _bestRef(p.isBuy, p.tick);
            if (!found) break;
            ++steps;
            RefOrder storage o = ref[i];
            if (o.owner == taker || o.owner == FAILING) {
                o.size = 0;
                continue;
            }
            uint96 req = want < o.size ? want : o.size;
            uint96 f = req;
            if (o.reduceOnly) {
                uint96 r = _reducible(o.owner, o.isBuy);
                if (r < f) f = r;
            }
            if (f == 0) {
                o.size = 0;
                continue;
            }
            refFills.push(Fill(o.id, o.owner, taker, o.tick, f));
            int256 d = int256(uint256(f));
            refPos[o.owner] += o.isBuy ? d : -d;
            refPos[taker] += p.isBuy ? d : -d;
            want -= f;
            o.size -= f;
            if (f < req) o.size = 0; // reduce-only clip cancels the rest
        }
        if (p.kind == Book.OrderType.LIMIT && want != 0 && !_crossesRef(p.isBuy, p.tick)) {
            return (true, want);
        }
        return (false, 0);
    }

    function _refCancel(uint32 id) internal {
        for (uint256 i; i < ref.length; ++i) {
            if (ref[i].id == id && ref[i].size != 0) ref[i].size = 0;
        }
    }

    // ------------------------------------------------------------------ driver

    function _decode(uint256 seed) internal pure returns (Book.Place memory p) {
        p.kind = Book.OrderType(seed % 3);
        p.isBuy = (seed >> 8) % 2 == 0;
        p.reduceOnly = (seed >> 16) % 6 == 0;
        p.tick = uint16(496 + (seed >> 24) % 9);
        p.size = uint96(1 + (seed >> 40) % 40);
        p.maxFills = uint8((seed >> 56) % 7);
    }

    function _bookFills() internal view returns (Fill[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == Book.Fill.selector) ++n;
        }
        out = new Fill[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Book.Fill.selector) continue;
            (uint32 maker, uint32 taker, uint16 tick, uint96 size) =
                abi.decode(logs[i].data, (uint32, uint32, uint16, uint96));
            out[n++] = Fill(uint32(uint256(logs[i].topics[2])), maker, taker, tick, size);
        }
    }

    function _step(uint256 seed) internal {
        uint32 trader = uint32(seed % 4) + 1;
        uint256 action = (seed >> 200) % 4;
        delete refFills;
        vm.recordLogs();

        if (action == 0 && ref.length != 0) {
            // Cancel one existing order (live or stale) through batch, as its owner.
            RefOrder memory o = ref[(seed >> 100) % ref.length];
            uint32[] memory c = new uint32[](1);
            c[0] = o.id;
            vm.prank(actors[o.owner - 1]);
            book.batch(M, c, new Book.Place[](0));
            _refCancel(o.id);
        } else {
            Book.Place memory p = _decode(seed >> 8);
            bool inBatch = action != 1;
            if (!inBatch && p.kind == Book.OrderType.POST_ONLY && _crossesRef(p.isBuy, p.tick)) {
                p.kind = Book.OrderType.LIMIT;
            }
            (bool rests, uint96 restSize) = _refPlace(trader, p, inBatch);
            uint32 id;
            vm.prank(actors[trader - 1]);
            if (inBatch) {
                Book.Place[] memory ps = new Book.Place[](1);
                ps[0] = p;
                id = book.batch(M, new uint32[](0), ps)[0];
            } else {
                id = book.placeOrder(M, p);
            }
            assertEq(id != 0, rests, "rests");
            if (rests) {
                assertEq(book.getOrder(M, id).size, restSize, "rest size");
                ref.push(RefOrder(id, trader, p.isBuy, p.reduceOnly, p.tick, restSize));
            }
        }

        Fill[] memory got = _bookFills();
        assertEq(got.length, refFills.length, "fill count");
        for (uint256 i; i < got.length; ++i) {
            assertEq(got[i].makerOrder, refFills[i].makerOrder, "fill maker order");
            assertEq(got[i].maker, refFills[i].maker, "fill maker");
            assertEq(got[i].taker, refFills[i].taker, "fill taker");
            assertEq(got[i].tick, refFills[i].tick, "fill tick");
            assertEq(got[i].size, refFills[i].size, "fill size");
        }
        _compareState();
    }

    function _compareState() internal view {
        uint16 bestBid;
        uint16 bestAsk;
        for (uint256 i; i < ref.length; ++i) {
            RefOrder storage o = ref[i];
            assertEq(book.getOrder(M, o.id).size, o.size, "order size");
            if (o.size == 0) continue;
            if (o.isBuy && o.tick > bestBid) bestBid = o.tick;
            if (!o.isBuy && (bestAsk == 0 || o.tick < bestAsk)) bestAsk = o.tick;
        }
        (uint16 bid, uint16 ask) = book.bestBidAsk(M);
        assertEq(bid, bestBid, "best bid");
        assertEq(ask, bestAsk, "best ask");
        for (uint32 t = 1; t <= 4; ++t) {
            assertEq(book.position(M, t), refPos[t], "position");
        }
    }

    function testFuzz_MatchesReference(uint256[48] calldata seeds) public {
        for (uint256 i; i < seeds.length; ++i) {
            _step(seeds[i]);
        }
    }

    /// A fixed long trace so deep books are compared regardless of the fuzzer's luck.
    function test_LongDeterministicTrace() public {
        for (uint256 i; i < 400; ++i) {
            uint256 fmp;
            assembly ("memory-safe") {
                fmp := mload(0x40)
            }
            _step(uint256(keccak256(abi.encode(i))));
            // Nothing from a step outlives it in memory; reuse it so 400 steps fit in one call.
            assembly ("memory-safe") {
                mstore(0x40, fmp)
            }
        }
    }
}
