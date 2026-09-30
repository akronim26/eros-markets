// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibBit} from "solady/utils/LibBit.sol";

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

    enum CancelReason {
        USER,
        SELF_TRADE, // resting order hit by its own owner
        FAILED_CHECK, // Clearing refused the maker fill
        CLIPPED // reduce-only maker exhausted its reducible size
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

    // ------------------------------------------------------------------ errors

    error MarketExists();
    error NoMarket();
    error NotLive();
    error NotOwner();
    error BookFull();

    // ------------------------------------------------------------------ Clearing hooks

    /// @dev Resting-order margin (R_buy, R_sell): `size` units started resting.
    function _onRest(uint256 market, uint32 trader, bool isBuy, uint16 tick, uint96 size) internal virtual;

    /// @dev `size` units stopped resting (filled or cancelled).
    function _onUnrest(uint256 market, uint32 trader, bool isBuy, uint96 size) internal virtual;

    // ------------------------------------------------------------------ external

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
        _onRest(market, trader, side == BID, tick, size);
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
        (uint32 owner, uint96 size, bool isBuy) = (o.owner, o.size, o.flags & FLAG_BUY != 0);
        emit OrderCancelled(market, _id(s, o.gen), size, reason);
        _unlink(b, s);
        _onUnrest(market, owner, isBuy, size);
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
