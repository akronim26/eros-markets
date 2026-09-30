// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Book} from "../src/Book.sol";

/// @notice Book with trivial Clearing hooks and read access to internals, for tests only.
contract BookHarness is Book {
    /// @dev Resting units per (market, trader, isBuy), maintained by the rest/unrest hooks.
    mapping(uint256 => mapping(uint32 => mapping(bool => uint256))) public reserved;

    function createMarket(uint256 market) external {
        _initBook(market);
    }

    /// @dev Rests an order without matching (placement lands with the match loop).
    function rest(uint256 market, bool isBuy, uint16 tick, uint96 size) external returns (uint32) {
        return _rest(_openBook(market), market, _traderOf(msg.sender), tick, size, isBuy ? FLAG_BUY : 0);
    }

    // ------------------------------------------------------------------ Clearing stand-in

    error TakerRejected();

    /// @dev Signed position per (market, trader); + is long.
    mapping(uint256 => mapping(uint32 => int256)) public position;
    mapping(uint32 => bool) public failMaker;
    bool public rejectTaker;
    uint256 public takerDoneCalls;

    /// @dev Stand-in for Clearing's snapshot: loaded in _takerStart, echoed by later hooks.
    uint256 public snapshotMark = 555;
    uint256 public makerSawMark;
    uint256 public takerFillSawMark;
    uint96 public doneFilled;
    uint256 public doneCost;
    uint256 public doneSawMark;

    function setPosition(uint256 market, uint32 trader, int256 pos) external {
        position[market][trader] = pos;
    }

    function setFailMaker(uint32 trader, bool fail) external {
        failMaker[trader] = fail;
    }

    function setSnapshotMark(uint256 mark) external {
        snapshotMark = mark;
    }

    function setRejectTaker(bool reject) external {
        rejectTaker = reject;
    }

    function _reducible(uint256 market, uint32 trader, bool isBuy) internal view returns (uint256) {
        int256 p = position[market][trader];
        if (isBuy) return p < 0 ? uint256(-p) : 0;
        return p > 0 ? uint256(p) : 0;
    }

    function _apply(uint256 market, uint32 trader, bool isBuy, uint96 size) internal {
        position[market][trader] += isBuy ? int256(uint256(size)) : -int256(uint256(size));
    }

    function _takerStart(Ctx memory c, uint96 size) internal view override returns (uint96) {
        c.risk.mark = snapshotMark;
        if (c.flags & FLAG_REDUCE_ONLY == 0) return size;
        uint256 r = _reducible(c.market, c.taker, c.takerBuys);
        return r < size ? uint96(r) : size;
    }

    function _makerFill(Ctx memory c, uint32 maker, bool makerBuys, uint16, uint96 size, uint8 flags)
        internal
        override
        returns (uint96 filled)
    {
        makerSawMark = c.risk.mark;
        if (failMaker[maker]) return 0;
        filled = size;
        if (flags & FLAG_REDUCE_ONLY != 0) {
            uint256 r = _reducible(c.market, maker, makerBuys);
            if (r < filled) filled = uint96(r);
        }
        _apply(c.market, maker, makerBuys, filled);
    }

    function _takerFill(Ctx memory c, bool takerBuys, uint16, uint96 size) internal override {
        takerFillSawMark = c.risk.mark;
        _apply(c.market, c.taker, takerBuys, size);
    }

    function _takerDone(Ctx memory c) internal override {
        if (rejectTaker) revert TakerRejected();
        ++takerDoneCalls;
        (doneFilled, doneCost, doneSawMark) = (c.filled, c.cost, c.risk.mark);
    }

    // ------------------------------------------------------------------ hooks

    /// @dev Stand-in for the market stage the oracle/resolution module (R4) drives.
    enum Stage {
        Open,
        ReduceOnly,
        Halted
    }

    error MarketHalted();
    error ReduceOnlyStage();
    error BelowMinSize();

    mapping(uint256 => Stage) public stage;
    uint8 public lastRestFlags;
    uint8 public lastUnrestFlags;
    uint96 public minSize;

    function setStage(uint256 market, Stage s) external {
        stage[market] = s;
    }

    function setMinSize(uint96 size) external {
        minSize = size;
    }

    function _admit(uint256 market, uint32, Place calldata p) internal view override {
        Stage s = stage[market];
        if (s == Stage.Halted) revert MarketHalted();
        if (s == Stage.ReduceOnly && !p.reduceOnly) revert ReduceOnlyStage();
        if (p.size < minSize) revert BelowMinSize();
    }

    function _onRest(uint256 market, uint32 trader, uint16, uint96 size, uint8 flags) internal override {
        reserved[market][trader][flags & FLAG_BUY != 0] += size;
        lastRestFlags = flags;
    }

    function _onUnrest(uint256 market, uint32 trader, uint96 size, uint8 flags) internal override {
        reserved[market][trader][flags & FLAG_BUY != 0] -= size;
        lastUnrestFlags = flags;
    }

    // ------------------------------------------------------------------ internals

    function forceCancel(uint256 market, uint32 id, CancelReason reason) external returns (bool) {
        return _forceCancel(market, id, reason);
    }

    function orderAt(uint256 market, uint32 slot) external view returns (Order memory) {
        return _books[market].orders[slot];
    }

    function freeHead(uint256 market) external view returns (uint32) {
        return _books[market].freeHead;
    }

    // ------------------------------------------------------------------ INV-8

    /// @dev Full structural check of one market's book; reverts with the first violation.
    ///      `traders` bounds the reservation check to ids 1..traders.
    function checkInvariants(uint256 market, uint32 traders) external view {
        BookState storage b = _books[market];
        uint256 n = b.orders.length;
        uint256[2][] memory resting = new uint256[2][](traders + 1);
        uint256 linked;

        for (uint8 side; side < 2; ++side) {
            for (uint256 w; w < WORDS; ++w) {
                uint256 word = b.bits[side][w];
                require(word & SENTINEL != 0, "sentinel cleared");
                require(word & ~(SENTINEL | TICK_MASK) == 0, "stray high bit");
            }
            require(b.bits[side][3] & (1 << 249) == 0, "tick 1000 bit set");
            for (uint16 k = MIN_TICK; k <= MAX_TICK; ++k) {
                Level storage lv = b.levels[k][side];
                uint256 i = k - 1;
                bool bit = b.bits[side][i / TICKS_PER_WORD] & (1 << (i % TICKS_PER_WORD)) != 0;
                require(bit == (lv.head != 0), "bit != non-empty");
                require((lv.head == 0) == (lv.tail == 0), "head/tail mismatch");
                require(lv.head == 0 || lv.used, "live level not marked used");
                uint256 sum;
                uint32 prev;
                for (uint32 s = lv.head; s != 0; s = b.orders[s].next) {
                    require(s < n, "link out of range");
                    require(++linked <= n, "cycle");
                    Order storage o = b.orders[s];
                    require(o.flags & FLAG_LIVE != 0, "dead order linked");
                    require(o.size != 0, "empty live order");
                    require(o.tick == k, "wrong tick");
                    require((o.flags & FLAG_BUY != 0) == (side == BID), "wrong side");
                    require(o.prev == prev, "prev link");
                    require(o.owner != 0 && o.owner <= traders, "bad owner");
                    resting[o.owner][side] += o.size;
                    sum += o.size;
                    prev = s;
                }
                require(prev == lv.tail, "tail link");
                require(sum == lv.size, "level size != sum of orders");
            }
        }

        // Every live slot is linked exactly once; every dead recyclable slot is on the free list.
        uint256 live;
        uint256 recyclable;
        for (uint256 s = 1; s < n; ++s) {
            Order storage o = b.orders[s];
            require(o.owner != 0, "slot returned to zero");
            if (o.flags & FLAG_LIVE != 0) ++live;
            else if (o.gen != MAX_GEN) ++recyclable;
            if (o.flags & FLAG_LIVE == 0) require(o.size == 0 && o.flags == 0, "tombstone not cleared");
        }
        require(live == linked, "live orders != linked orders");
        uint256 free;
        for (uint32 s = b.freeHead; s != 0; s = b.orders[s].next) {
            require(++free <= n, "free-list cycle");
            require(b.orders[s].flags == 0, "live order on free list");
            require(b.orders[s].gen != MAX_GEN, "retired slot on free list");
        }
        require(free == recyclable, "free list incomplete");

        for (uint32 t = 1; t <= traders; ++t) {
            require(reserved[market][t][false] == resting[t][ASK], "ask reservation");
            require(reserved[market][t][true] == resting[t][BID], "bid reservation");
        }

        uint16 bid = _bestBid(b);
        uint16 ask = _bestAsk(b);
        require(bid == NONE || ask == NONE || bid < ask, "crossed book");
    }

    function setBit(uint256 market, bool isBuy, uint16 tick) external {
        _setBit(_openBook(market), isBuy ? BID : ASK, tick);
    }

    function clearBit(uint256 market, bool isBuy, uint16 tick) external {
        _clearBit(_openBook(market), isBuy ? BID : ASK, tick);
    }

    function bitWord(uint256 market, bool isBuy, uint256 w) external view returns (uint256) {
        return _books[market].bits[isBuy ? BID : ASK][w];
    }

    function orderSlots(uint256 market) external view returns (uint256) {
        return _books[market].orders.length;
    }
}
