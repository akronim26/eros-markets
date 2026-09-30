// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibBit} from "solady/utils/LibBit.sol";
import {RiskSnapshot} from "./RiskSnapshot.sol";

/// @title Book
/// @notice Fully on-chain price-time CLOB over the 999 ticks 0.001 .. 0.999 (design spec §9).
/// @dev Storage is laid out for Monad's page-priced storage (MIP-8): bitmaps, levels and orders
///      never return to zero once used. Clearing plugs in through the internal hooks; the book
///      never touches accounts and Clearing never touches the book.
abstract contract Book {
    // ------------------------------------------------------------------ constants

    uint16 internal constant MIN_TICK = 1;
    uint16 internal constant MAX_TICK = 999;
    /// @dev Returned by best-price lookups for an empty side; never a valid tick.
    uint16 internal constant NONE = 0;

    uint256 internal constant TICKS_PER_WORD = 250;
    uint256 internal constant WORDS = 4;
    /// @dev Bit 255 of every bitmap word stays set so the word never returns to zero.
    uint256 internal constant SENTINEL = 1 << 255;
    uint256 internal constant TICK_MASK = (1 << TICKS_PER_WORD) - 1;

    /// @dev Side index into levels[tick][side] and bits[side].
    uint8 internal constant ASK = 0;
    uint8 internal constant BID = 1;

    uint8 public constant FLAG_BUY = 1;
    uint8 public constant FLAG_REDUCE_ONLY = 2;
    uint8 public constant FLAG_LIVE = 4;

    /// @dev Public order id = gen << 24 | slot.
    uint256 internal constant SLOT_BITS = 24;
    uint256 internal constant SLOT_MASK = (1 << SLOT_BITS) - 1;
    /// @dev A slot whose generation reached this value is retired instead of recycled, so an id is
    ///      never reissued and a stale cancel can never hit a newer order.
    uint8 internal constant MAX_GEN = type(uint8).max;

    /// @notice Protocol bound on orders examined per taker order; the UI requests about 8.
    uint256 public constant MAX_FILLS = 64;

    enum OrderType {
        LIMIT, // match, then rest the remainder
        IOC, // match, then drop the remainder
        POST_ONLY // never match; rest or reject
    }

    enum CancelReason {
        USER,
        SELF_TRADE, // resting order hit by its own owner
        FAILED_CHECK, // Clearing refused the maker fill
        CLIPPED, // reduce-only maker exhausted its reducible size
        RISK, // protocol cancel: liquidation or unhealthy account
        STAGE // protocol cancel: market stage change
    }

    struct Place {
        OrderType kind;
        bool isBuy;
        bool reduceOnly;
        uint16 tick;
        uint96 size;
        uint8 maxFills; // orders the match may examine, counting self-trades and failed makers
    }

    /// @dev Per-order taker context handed to every Clearing hook of that order.
    struct Ctx {
        uint256 market;
        uint32 taker;
        bool takerBuys;
        uint8 flags;
        uint96 filled; // Book-maintained: taker units filled so far
        uint256 cost; // Book-maintained: sum of fill size x tick (units of 0.001 USDC)
        RiskSnapshot risk; // Clearing-owned; Book never reads it
    }

    // ------------------------------------------------------------------ storage

    /// @dev One slot. `used` stays true after first use so the slot never returns to zero.
    struct Level {
        uint32 head; // oldest order slot
        uint32 tail; // newest order slot
        uint96 size; // total resting units at this tick
        bool used;
    }

    /// @dev One slot (224 bits). A dead order keeps owner/tick/gen as a non-zero tombstone.
    struct Order {
        uint32 owner; // trader id
        uint96 size; // remaining units; 0 = dead
        uint32 next; // next in level; while dead: next free slot
        uint32 prev;
        uint16 tick; // 1..999
        uint8 flags; // FLAG_BUY | FLAG_REDUCE_ONLY | FLAG_LIVE
        uint8 gen; // bumped on every reuse; part of the public id
    }

    struct BookState {
        uint256[WORDS][2] bits; // [ASK|BID][word]; tick k -> word (k-1)/250, bit (k-1)%250
        uint32 freeHead; // top of the free-slot stack
        Level[2][1000] levels; // [tick][ASK|BID]: a tick's two sides share a page
        Order[] orders; // index = slot; slot 0 = null
    }

    mapping(uint256 market => BookState) internal _books;

    /// @notice Trader ids start at 1; 0 means unregistered.
    mapping(address account => uint32) public traderId;
    uint32 public traderCount;

    // ------------------------------------------------------------------ events

    event TraderRegistered(address indexed account, uint32 indexed trader);
    event OrderPlaced(
        uint256 indexed market,
        uint32 indexed id,
        uint32 indexed trader,
        uint16 tick,
        uint96 size,
        uint8 flags
    );
    event OrderCancelled(uint256 indexed market, uint32 indexed id, uint96 size, CancelReason reason);
    event Fill(
        uint256 indexed market,
        uint32 indexed makerOrder,
        uint32 maker,
        uint32 taker,
        uint16 tick,
        uint96 size
    );

    // ------------------------------------------------------------------ errors

    error MarketExists();
    error NoMarket();
    error NotLive();
    error NotOwner();
    error BookFull();
    error BadTick();
    error BadSize();
    error BadMaxFills();
    error PostOnlyCrosses();

    // ------------------------------------------------------------------ Clearing hooks

    /// @dev Load the taker and settle its funding once; returns the size it may trade
    ///      (a reduce-only taker is clipped to its position here).
    function _takerStart(Ctx memory c, uint96 size) internal virtual returns (uint96 allowed);

    /// @dev Check and update the maker. 0 = failed check (the order is cancelled);
    ///      less than `size` = reduce-only clip (the rest of the order is cancelled).
    function _makerFill(Ctx memory c, uint32 maker, bool makerBuys, uint16 tick, uint96 size, uint8 flags)
        internal
        virtual
        returns (uint96 filled);

    /// @dev Taker side of one fill; memory only. `c.filled` and `c.cost` already include it.
    function _takerFill(Ctx memory c, bool takerBuys, uint16 tick, uint96 size) internal virtual;

    /// @dev Final taker checks and the single account write; reverts on failure. `c.filled` and
    ///      `c.cost` hold the order's totals.
    function _takerDone(Ctx memory c) internal virtual;

    /// @dev Admission gate for every new order, before anything else happens: market stage
    ///      (Halted accepts nothing, ReduceOnly only reduce-only orders), price band, minimum size.
    ///      Reverts to reject; in a batch that reverts the whole batch. Cancels are never gated.
    function _admit(uint256 market, uint32 trader, Place calldata p) internal virtual;

    /// @dev Resting-order margin (R_buy, R_sell): `size` units started resting. `flags` carry the
    ///      side (FLAG_BUY) and FLAG_REDUCE_ONLY. May revert to refuse the rest.
    function _onRest(uint256 market, uint32 trader, uint16 tick, uint96 size, uint8 flags) internal virtual;

    /// @dev `size` units of an order with `flags` stopped resting (filled or cancelled).
    function _onUnrest(uint256 market, uint32 trader, uint96 size, uint8 flags) internal virtual;

    // ------------------------------------------------------------------ external

    /// @notice Place one order. Returns the resting order's id, or 0 if nothing rests.
    function placeOrder(uint256 market, Place calldata p) external returns (uint32 id) {
        return _place(_openBook(market), market, _traderOf(msg.sender), p, false);
    }

    /// @notice Requote in one call: every cancel first, then the places in order. Cancelling an
    ///         order that already filled or was cancelled does nothing, and a crossing post-only
    ///         order is skipped with id 0, so a fill landing between a bot's read and its requote
    ///         never reverts the batch.
    function batch(uint256 market, uint32[] calldata cancels, Place[] calldata places)
        external
        returns (uint32[] memory ids)
    {
        BookState storage b = _openBook(market);
        uint32 trader = _traderOf(msg.sender);
        for (uint256 i; i < cancels.length; ++i) {
            _cancelOwn(b, market, trader, cancels[i]);
        }
        ids = new uint32[](places.length);
        for (uint256 i; i < places.length; ++i) {
            ids[i] = _place(b, market, trader, places[i], true);
        }
    }

    /// @notice Cancel a live order owned by the caller. Reverts if it is no longer live.
    function cancel(uint256 market, uint32 id) external {
        if (!_cancelOwn(_openBook(market), market, traderId[msg.sender], id)) revert NotLive();
    }

    // ------------------------------------------------------------------ views

    /// @notice Best bid and best ask ticks; NONE (0) for an empty side.
    function bestBidAsk(uint256 market) external view returns (uint16 bid, uint16 ask) {
        BookState storage b = _openBook(market);
        return (_bestBid(b), _bestAsk(b));
    }

    /// @notice Best prices and the size resting at each (0 when a side is empty).
    function touch(uint256 market)
        external
        view
        returns (uint16 bid, uint96 bidSize, uint16 ask, uint96 askSize)
    {
        return _touch(market);
    }

    /// @notice The level at `tick` on one side; one read, used by the mark's depth filter.
    function getLevel(uint256 market, bool isBuy, uint16 tick) external view returns (Level memory) {
        return _openBook(market).levels[tick][isBuy ? BID : ASK];
    }

    /// @notice The order behind `id`, or an all-zero order if `id` is not live.
    function getOrder(uint256 market, uint32 id) external view returns (Order memory o) {
        BookState storage b = _openBook(market);
        (uint32 s, bool live) = _liveSlot(b, id);
        if (live) o = b.orders[s];
    }

    // ------------------------------------------------------------------ module interface

    /// @dev Best prices with the size resting there: the mark's inputs, where a best level below
    ///      D_min counts as missing (spec §5.3).
    function _touch(uint256 market)
        internal
        view
        returns (uint16 bid, uint96 bidSize, uint16 ask, uint96 askSize)
    {
        BookState storage b = _openBook(market);
        bid = _bestBid(b);
        ask = _bestAsk(b);
        if (bid != NONE) bidSize = b.levels[bid][BID].size;
        if (ask != NONE) askSize = b.levels[ask][ASK].size;
    }

    /// @dev Protocol cancel for other modules (liquidation, stage change, keepers removing
    ///      unhealthy makers). No owner check: the calling module authorises it. Order ids come
    ///      from the caller (e.g. the indexer); the book keeps no per-trader order list. Returns
    ///      false if `id` is not live, so stale ids are harmless.
    function _forceCancel(uint256 market, uint32 id, CancelReason reason) internal returns (bool) {
        BookState storage b = _openBook(market);
        (uint32 s, bool live) = _liveSlot(b, id);
        if (!live) return false;
        _cancel(b, market, s, reason);
        return true;
    }

    // ------------------------------------------------------------------ place

    /// @dev In a batch a crossing post-only order returns 0 instead of reverting.
    function _place(BookState storage b, uint256 market, uint32 trader, Place calldata p, bool inBatch)
        internal
        returns (uint32 id)
    {
        if (p.tick < MIN_TICK || p.tick > MAX_TICK) revert BadTick();
        if (p.size == 0) revert BadSize();
        if (p.maxFills > MAX_FILLS) revert BadMaxFills();
        _admit(market, trader, p);
        uint8 flags = (p.isBuy ? FLAG_BUY : 0) | (p.reduceOnly ? FLAG_REDUCE_ONLY : 0);

        if (p.kind == OrderType.POST_ONLY) {
            if (_crosses(b, p.isBuy, p.tick)) {
                if (inBatch) return 0;
                revert PostOnlyCrosses();
            }
            return _rest(b, market, trader, p.tick, p.size, flags);
        }

        Ctx memory c;
        (c.market, c.taker, c.takerBuys, c.flags) = (market, trader, p.isBuy, flags);
        uint96 want = _takerStart(c, p.size);
        if (want > p.size) want = p.size;
        want = _match(b, c, p.tick, want, p.maxFills);
        _takerDone(c);
        // If maxFills ran out while the book still crosses the limit, the remainder is dropped:
        // resting it would leave best bid >= best ask (INV-8).
        if (p.kind == OrderType.LIMIT && want != 0 && !_crosses(b, p.isBuy, p.tick)) {
            id = _rest(b, market, trader, p.tick, want, flags);
        }
    }

    function _crosses(BookState storage b, bool isBuy, uint16 tick) internal view returns (bool) {
        if (isBuy) {
            uint16 ask = _bestAsk(b);
            return ask != NONE && ask <= tick;
        }
        uint16 bid = _bestBid(b);
        return bid != NONE && bid >= tick;
    }

    // ------------------------------------------------------------------ match

    /// @dev Walks the opposite side best price first, oldest first, examining at most `maxFills`
    ///      orders. Self-trades and failed makers are cancelled and still count as a step, so
    ///      gas stays bounded whatever sits at the touch. Returns the unfilled size.
    function _match(BookState storage b, Ctx memory c, uint16 limit, uint96 want, uint256 maxFills)
        internal
        returns (uint96)
    {
        uint256 steps;
        while (want != 0 && steps < maxFills) {
            uint16 k = c.takerBuys ? _bestAsk(b) : _bestBid(b);
            if (k == NONE || (c.takerBuys ? k > limit : k < limit)) break;
            // A partly filled maker stays at the head only when `want` hit zero, which ends both
            // loops, so walking on to `next` after every step is safe.
            for (
                uint32 s = b.levels[k][c.takerBuys ? ASK : BID].head;
                s != 0 && want != 0 && steps < maxFills;

            ) {
                uint32 next = b.orders[s].next;
                want -= _step(b, c, s, k, want); // a hook overfill underflows here and reverts
                ++steps;
                s = next;
            }
        }
        return want;
    }

    /// @dev Examines the order in slot `s` at tick `k` and returns the units filled.
    function _step(BookState storage b, Ctx memory c, uint32 s, uint16 k, uint96 want)
        internal
        returns (uint96 filled)
    {
        Order storage o = b.orders[s];
        (uint32 maker, uint8 flags) = (o.owner, o.flags & ~FLAG_LIVE);
        if (maker == c.taker) {
            _cancel(b, c.market, s, CancelReason.SELF_TRADE);
            return 0;
        }
        uint96 size = o.size;
        uint96 req = want < size ? want : size;
        filled = _makerFill(c, maker, !c.takerBuys, k, req, flags);
        if (filled == 0) {
            _cancel(b, c.market, s, CancelReason.FAILED_CHECK);
            return 0;
        }
        c.filled += filled;
        c.cost += uint256(filled) * k;
        _takerFill(c, c.takerBuys, k, filled);
        emit Fill(c.market, _id(s, o.gen), maker, c.taker, k, filled);
        if (filled == size) {
            _unlink(b, s);
        } else {
            o.size = size - filled;
            b.levels[k][c.takerBuys ? ASK : BID].size -= filled;
        }
        _onUnrest(c.market, maker, filled, flags);
        // Reduce-only maker clipped: nothing more of it can fill.
        if (filled < req) _cancel(b, c.market, s, CancelReason.CLIPPED);
    }

    // ------------------------------------------------------------------ rest / cancel

    /// @dev Appends at the tail of the level, reusing a free slot when one exists.
    function _rest(BookState storage b, uint256 market, uint32 trader, uint16 tick, uint96 size, uint8 flags)
        internal
        returns (uint32 id)
    {
        uint32 s = b.freeHead;
        uint8 gen;
        if (s != 0) {
            Order storage dead = b.orders[s];
            b.freeHead = dead.next;
            gen = dead.gen + 1;
        } else {
            uint256 n = b.orders.length;
            if (n > SLOT_MASK) revert BookFull();
            s = uint32(n);
            b.orders.push();
        }
        uint8 side = flags & FLAG_BUY != 0 ? BID : ASK;
        Level storage lv = b.levels[tick][side];
        uint32 tail = lv.tail;
        b.orders[s] = Order(trader, size, 0, tail, tick, flags | FLAG_LIVE, gen);
        if (tail == 0) {
            lv.head = s;
            _setBit(b, side, tick);
        } else {
            b.orders[tail].next = s;
        }
        lv.tail = s;
        lv.size += size;
        lv.used = true;
        id = _id(s, gen);
        emit OrderPlaced(market, id, trader, tick, size, flags);
        _onRest(market, trader, tick, size, flags);
    }

    /// @dev Returns false if `id` is not live; reverts if it is live but not the trader's.
    function _cancelOwn(BookState storage b, uint256 market, uint32 trader, uint32 id)
        internal
        returns (bool)
    {
        (uint32 s, bool live) = _liveSlot(b, id);
        if (!live) return false;
        if (b.orders[s].owner != trader) revert NotOwner();
        _cancel(b, market, s, CancelReason.USER);
        return true;
    }

    function _cancel(BookState storage b, uint256 market, uint32 s, CancelReason reason) internal {
        Order storage o = b.orders[s];
        (uint32 owner, uint96 size, uint8 flags) = (o.owner, o.size, o.flags & ~FLAG_LIVE);
        emit OrderCancelled(market, _id(s, o.gen), size, reason);
        _unlink(b, s);
        _onUnrest(market, owner, size, flags);
    }

    /// @dev Unlinks a live order in O(1), clears the tick bit if the level empties, and turns the
    ///      slot into a non-zero tombstone on the free list (or retires it at MAX_GEN).
    function _unlink(BookState storage b, uint32 s) internal {
        Order storage o = b.orders[s];
        uint8 side = o.flags & FLAG_BUY != 0 ? BID : ASK;
        uint16 tick = o.tick;
        Level storage lv = b.levels[tick][side];
        (uint32 prev, uint32 next) = (o.prev, o.next);
        if (prev == 0) lv.head = next;
        else b.orders[prev].next = next;
        if (next == 0) lv.tail = prev;
        else b.orders[next].prev = prev;
        lv.size -= o.size;
        if (lv.head == 0) _clearBit(b, side, tick);

        o.size = 0;
        o.flags = 0;
        o.prev = 0;
        if (o.gen == MAX_GEN) {
            o.next = 0;
        } else {
            o.next = b.freeHead;
            b.freeHead = s;
        }
    }

    // ------------------------------------------------------------------ ids

    function _id(uint32 s, uint8 gen) internal pure returns (uint32) {
        return (uint32(gen) << uint32(SLOT_BITS)) | s;
    }

    function _liveSlot(BookState storage b, uint32 id) internal view returns (uint32 s, bool live) {
        s = uint32(id & SLOT_MASK);
        if (s == 0 || s >= b.orders.length) return (s, false);
        Order storage o = b.orders[s];
        live = o.flags & FLAG_LIVE != 0 && o.gen == uint8(id >> SLOT_BITS);
    }

    function _traderOf(address account) internal returns (uint32 id) {
        id = traderId[account];
        if (id == 0) {
            id = ++traderCount;
            traderId[account] = id;
            emit TraderRegistered(account, id);
        }
    }

    // ------------------------------------------------------------------ market setup

    function _initBook(uint256 market) internal {
        BookState storage b = _books[market];
        if (_isOpen(b)) revert MarketExists();
        for (uint256 w; w < WORDS; ++w) {
            b.bits[ASK][w] = SENTINEL;
            b.bits[BID][w] = SENTINEL;
        }
        b.orders.push(); // slot 0 is the null order
    }

    function _isOpen(BookState storage b) internal view returns (bool) {
        return b.bits[ASK][0] != 0;
    }

    function _openBook(uint256 market) internal view returns (BookState storage b) {
        b = _books[market];
        if (!_isOpen(b)) revert NoMarket();
    }

    // ------------------------------------------------------------------ bitmap

    function _setBit(BookState storage b, uint8 side, uint16 tick) internal {
        unchecked {
            uint256 i = tick - 1;
            b.bits[side][i / TICKS_PER_WORD] |= 1 << (i % TICKS_PER_WORD);
        }
    }

    function _clearBit(BookState storage b, uint8 side, uint16 tick) internal {
        unchecked {
            uint256 i = tick - 1;
            b.bits[side][i / TICKS_PER_WORD] &= ~(1 << (i % TICKS_PER_WORD));
        }
    }

    /// @dev Highest set tick bit on the bid side, scanning at most four words.
    function _bestBid(BookState storage b) internal view returns (uint16) {
        unchecked {
            for (uint256 w = WORDS; w != 0;) {
                --w;
                uint256 x = b.bits[BID][w] & TICK_MASK;
                if (x != 0) return uint16(w * TICKS_PER_WORD + LibBit.fls(x) + 1);
            }
        }
        return NONE;
    }

    /// @dev Lowest set tick bit on the ask side, scanning at most four words.
    function _bestAsk(BookState storage b) internal view returns (uint16) {
        unchecked {
            for (uint256 w; w < WORDS; ++w) {
                uint256 x = b.bits[ASK][w] & TICK_MASK;
                if (x != 0) return uint16(w * TICKS_PER_WORD + LibBit.ffs(x) + 1);
            }
        }
        return NONE;
    }
}
