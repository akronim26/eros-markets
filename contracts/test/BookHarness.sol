// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Book} from "../src/Book.sol";

/// @notice Book with trivial Clearing hooks and read access to internals, for tests only.
contract BookHarness is Book {
    function createMarket(uint256 market) external {
        _initBook(market);
    }

    // ------------------------------------------------------------------ internals

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
