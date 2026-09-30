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
