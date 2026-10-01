// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";

library LedgerMath {
    uint256 internal constant UNIT = 1000e18;

    struct Value {
        int128 lots;
        int256 cashQ;
    }
    error Domain();

    function equity(Value memory a, uint256 priceWad) internal pure returns (int256) {
        if (priceWad > 1e18) revert Domain();
        Q.position(a.lots);
        Q.cash(a.cashQ);
        return a.cashQ + int256(a.lots) * 1000 * int256(priceWad);
    }

    function endpoints(Value memory a) internal pure returns (int256 e0, int256 e1) {
        return (equity(a, 0), equity(a, 1e18));
    }

    function fill(
        Value memory buyer,
        Value memory seller,
        uint64 lots,
        uint16 tick,
        uint256 buyerFee,
        uint256 sellerFee
    ) internal pure returns (Value memory b, Value memory s) {
        if (lots == 0 || tick == 0 || tick >= 1000) revert Domain();
        int256 value = int256(uint256(lots) * tick * 1e18);
        b = Value(
            Q.position(int256(buyer.lots) + int256(uint256(lots))),
            Q.cash(buyer.cashQ - value - Q.signed(buyerFee))
        );
        s = Value(
            Q.position(int256(seller.lots) - int256(uint256(lots))),
            Q.cash(seller.cashQ + value - Q.signed(sellerFee))
        );
    }

    function takeover(Value memory trader, Value memory reserve) internal pure returns (Value memory) {
        return Value(Q.position(int256(trader.lots) + reserve.lots), Q.cash(trader.cashQ + reserve.cashQ));
    }
}
