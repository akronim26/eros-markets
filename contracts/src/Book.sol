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

    // ------------------------------------------------------------------ errors

    error MarketExists();
    error NoMarket();

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
