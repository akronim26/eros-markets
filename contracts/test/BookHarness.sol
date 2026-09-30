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

    function setPosition(uint256 market, uint32 trader, int256 pos) external {
        position[market][trader] = pos;
    }

    function setFailMaker(uint32 trader, bool fail) external {
        failMaker[trader] = fail;
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
        if (c.flags & FLAG_REDUCE_ONLY == 0) return size;
        uint256 r = _reducible(c.market, c.taker, c.takerBuys);
        return r < size ? uint96(r) : size;
    }

    function _makerFill(Ctx memory c, uint32 maker, bool makerBuys, uint16, uint96 size, uint8 flags)
        internal
        override
        returns (uint96 filled)
    {
        if (failMaker[maker]) return 0;
        filled = size;
        if (flags & FLAG_REDUCE_ONLY != 0) {
            uint256 r = _reducible(c.market, maker, makerBuys);
            if (r < filled) filled = uint96(r);
        }
        _apply(c.market, maker, makerBuys, filled);
    }

    function _takerFill(Ctx memory c, bool takerBuys, uint16, uint96 size) internal override {
        _apply(c.market, c.taker, takerBuys, size);
    }

    function _takerDone(Ctx memory) internal override {
        if (rejectTaker) revert TakerRejected();
        ++takerDoneCalls;
    }

    // ------------------------------------------------------------------ hooks

    function _onRest(uint256 market, uint32 trader, bool isBuy, uint16, uint96 size) internal override {
        reserved[market][trader][isBuy] += size;
    }

    function _onUnrest(uint256 market, uint32 trader, bool isBuy, uint96 size) internal override {
        reserved[market][trader][isBuy] -= size;
    }

    // ------------------------------------------------------------------ internals

    function orderAt(uint256 market, uint32 slot) external view returns (Order memory) {
        return _books[market].orders[slot];
    }

    function freeHead(uint256 market) external view returns (uint32) {
        return _books[market].freeHead;
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
